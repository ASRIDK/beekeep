import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexSandbox, codexStarter, toolOf, unwrapShell } from '../server/codex.ts';
import { Hive } from '../server/hive.ts';
import { Store } from '../server/store.ts';
import { type BeeRow, type BeeView, NO_ABILITIES } from '../server/types.ts';
import { Warden } from '../server/warden.ts';

const fake = { command: process.execPath, args: [fileURLToPath(new URL('./fake-codex.mjs', import.meta.url)), 'app-server'] };
let dir: string;
let ws: string;
let store: Store;
let hive: Hive;
let warden: Warden;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'beekeep-codex-')));
  ws = join(dir, 'ws');
  mkdirSync(ws);
  process.env.BEEKEEP_CODEX_HOME = join(dir, 'codex');
  store = new Store(join(dir, 'hive.db'));
  warden = new Warden();
  hive = new Hive({ store, start: codexStarter(fake, warden, () => {}) });
});

afterEach(() => {
  hive.shutdown();
  warden.dismiss();
  store.close();
});

const bee = (over: Partial<BeeRow> = {}) =>
  hive.createBee({ name: 'Codie', agent: 'codex', mode: 'work', workspace: ws, abilities: { ...NO_ABILITIES, shell: true }, ...over });

/** Gives an order and waits until it has ended, answering what the bee asks with `decide`. */
async function run(b: BeeView, text: string, decide: (tool: string, input: Record<string, unknown>) => boolean | 'always' = () => false) {
  const order = hive.order(b.id, text);
  for (let i = 0; i < 400; i++) {
    for (const a of store.waitingApprovals()) {
      const d = decide(a.tool, a.input);
      hive.decide(a.id, d !== false, { always: d === 'always' });
    }
    if (store.order(order.id)!.endedAt) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const events = store.events(b.id, undefined, 500);
  return {
    status: store.order(order.id)!.status,
    events,
    said: events.filter((e) => e.kind === 'say').map((e) => String(e.data.text)),
    asked: events.filter((e) => e.kind === 'approval').map((e) => ({ tool: e.data.tool, input: e.data.input as Record<string, unknown> })),
  };
}

describe('Codex bees', () => {
  it('show what Codex says and does in the same history as Claude bees', async () => {
    const b = bee();
    const r = await run(b, 'say hello');
    expect(r.status).toBe('done');
    expect(r.said).toEqual(['Hello!']);
    const turn = r.events.find((e) => e.kind === 'turn')!;
    expect(turn.data).toMatchObject({ ok: true, ms: 42, tokensIn: 1200, tokensOut: 30 });
    expect(store.bees()[0]!.sessionId).toBe('thread-new');

    const run2 = await run(b, 'please run it');
    const action = run2.events.find((e) => e.kind === 'action')!;
    expect(action.data).toMatchObject({ tool: 'Bash', input: { command: 'ls -la' } });
    expect(run2.events.find((e) => e.kind === 'result')!.data).toMatchObject({ ok: true, text: 'a.txt' });
  });

  it('ask the keeper before commands Codex does not know to be safe, and remember an always', async () => {
    const b = bee();
    let r = await run(b, 'escalate', () => false);
    expect(r.asked).toMatchObject([{ tool: 'Bash', input: { command: 'curl https://example.org', description: 'needs the network' } }]);
    expect(r.said).toContain('decision: decline');
    r = await run(b, 'escalate', () => 'always');
    expect(r.said.at(-1)).toBe('decision: accept');
    r = await run(b, 'escalate', () => false);
    expect(r.asked).toHaveLength(2); // The exact command was allowed always.
    expect(r.said.at(-1)).toBe('decision: accept');

    const look = bee({ name: 'Looker', mode: 'look' });
    r = await run(look, 'escalate', () => true);
    expect(r.asked).toEqual([]); // A look bee runs nothing beyond what Codex knows is safe.
    expect(r.said).toContain('decision: decline');
  });

  it('ask per site for the network, and remember an always', async () => {
    const b = bee();
    let r = await run(b, 'network', () => 'always');
    expect(r.asked).toMatchObject([{ tool: 'SandboxNetworkAccess', input: { host: 'example.org' } }]);
    expect(r.said).toContain('decision: accept');
    r = await run(b, 'network again', () => false);
    expect(r.asked).toHaveLength(1); // No new question: the site was allowed always.
    expect(r.said.at(-1)).toBe('decision: accept');
  });

  it('show a change outside their folder, with its diff, before it happens', async () => {
    const b = bee();
    const r = await run(b, 'outside', () => false);
    expect(r.asked).toMatchObject([{ tool: 'Write', input: { file_path: '/elsewhere/x.txt', content: '+hi' } }]);
    expect(r.said).toContain('decision: decline');
    const look = bee({ name: 'Looker', mode: 'look' });
    const r2 = await run(look, 'outside', () => true);
    expect(r2.asked).toEqual([]); // A look bee may not change files at all.
    expect(r2.said).toContain('decision: decline');
  });

  it('refuse questions and other requests beekeep does not handle', async () => {
    const r = await run(bee(), 'question');
    expect(r.said).toContain('refused: -32601');
  });

  it('stop when the keeper stops them, and report failures', async () => {
    const b = bee();
    const order = hive.order(b.id, 'slow');
    for (let i = 0; i < 100 && store.order(order.id)!.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 100));
    hive.stop(b.id);
    for (let i = 0; i < 200 && !store.order(order.id)!.endedAt; i++) await new Promise((r) => setTimeout(r, 10));
    expect(store.order(order.id)!.status).toBe('stopped');
    const r = await run(b, 'fail');
    expect(r.status).toBe('failed');
  });

  it('pick up their conversation again after a restart', async () => {
    const b = bee();
    await run(b, 'say hello');
    hive.shutdown();
    hive = new Hive({ store, start: codexStarter(fake, warden, () => {}) });
    const r = await run(hive.views()[0]!, 'whoami');
    expect(r.said.at(-1)).toBe('thread: thread-new, resumed: true');
  });

  it('get a sandbox that matches what they may do, with the network closed', async () => {
    const look = await run(bee({ name: 'L', mode: 'look' }), 'sandbox');
    expect(JSON.parse(look.said[0]!.slice('policy: '.length))).toEqual({ type: 'readOnly', networkAccess: false });
    const work = await run(bee({ name: 'W' }), 'sandbox');
    expect(JSON.parse(work.said[0]!.slice('policy: '.length))).toMatchObject({ type: 'workspaceWrite', writableRoots: [ws], networkAccess: false });
  });

  it('use a Codex profile of their own, and say how to log it in', async () => {
    process.env.BEEKEEP_CODEX_HOME = join(dir, 'logged-out');
    const r = await run(bee(), 'say hello');
    expect(r.status).toBe('failed');
    expect(JSON.stringify(r.events)).toContain('beekeep login codex');
  });

  it('cannot be queens yet, and take any model name Codex knows', () => {
    expect(() => bee({ name: 'Q', kind: 'queen' })).toThrow(/queen runs on Claude Code/);
    expect(bee({ name: 'M', model: 'gpt-5.5-codex' }).model).toBe('gpt-5.5-codex');
    expect(() => bee({ name: 'N', model: 'rm -rf /' })).toThrow(/Not a model name/);
    expect(bee({ name: 'D' }).model).toBe('default');
  });
});

describe('reading Codex', () => {
  it('shows the command, not the shell around it', () => {
    expect(unwrapShell("/bin/zsh -lc 'npm test'")).toBe('npm test');
    expect(unwrapShell(`/bin/bash -lc 'echo '\\''hi'\\'''`)).toBe("echo 'hi'");
    expect(unwrapShell('git status')).toBe('git status');
    expect(unwrapShell(`/bin/zsh -lc "printf 'hi' > \\"x y\\""`)).toBe(`printf 'hi' > "x y"`);
  });

  it('names its tools as Claude Code does', () => {
    expect(toolOf({ type: 'fileChange', id: '1', changes: [{ path: 'a', kind: { type: 'add' } }] })).toEqual({ name: 'Write', input: { file_path: 'a' } });
    expect(toolOf({ type: 'fileChange', id: '1', changes: [{ path: 'a', kind: { type: 'update' } }, { path: 'b', kind: { type: 'delete' } }] })).toEqual({
      name: 'Edit',
      input: { file_path: 'a', more: ['b'] },
    });
    expect(toolOf({ type: 'mcpToolCall', id: '1', server: 's', tool: 't', arguments: { x: 1 } })).toEqual({ name: 'mcp__s__t', input: { x: 1 } });
    expect(codexSandbox({ mode: 'full', workspace: '/w' } as BeeRow).mode).toBe('workspace-write');
  });
});
