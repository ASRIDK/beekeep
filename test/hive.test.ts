import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverHooks, StartDriver } from '../server/driver.ts';
import { Hive, type HiveOptions, pickNext } from '../server/hive.ts';
import { Store } from '../server/store.ts';
import type { BeeRow, OrderRow } from '../server/types.ts';

// A stand-in for a real bee: records what it was told, speaks when the test says so.
class FakeBee {
  sent: string[] = [];
  interrupts = 0;
  closed = false;
  interruptFails = false;
  bee: BeeRow;
  hooks: DriverHooks;

  constructor(bee: BeeRow, hooks: DriverHooks) {
    this.bee = bee;
    this.hooks = hooks;
  }

  emit(m: unknown) {
    this.hooks.onMessage(m as SDKMessage);
  }

  finish(over: object = {}) {
    this.emit({
      type: 'result', subtype: 'success', is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0,
      usage: { input_tokens: 10, output_tokens: 2 }, ...over,
    });
  }
}

let dir: string;
let store: Store;
let hive: Hive;
let fakes: FakeBee[];
let pushed: { ev: string }[];

const flush = () => new Promise((r) => setTimeout(r, 0));

const startFake: StartDriver = async (bee, hooks) => {
  const f = new FakeBee(bee, hooks);
  fakes.push(f);
  return {
    send: (t) => void f.sent.push(t),
    interrupt: async () => {
      f.interrupts += 1;
      if (f.interruptFails) throw new Error('pipe closed');
    },
    close: () => void (f.closed = true),
  };
};

function open(opts: Partial<HiveOptions> = {}) {
  hive = new Hive({ store, start: startFake, ...opts });
  hive.recover();
  pushed = [];
  hive.on('push', (m) => pushed.push(m));
}

const add = (name: string, mode: BeeRow['mode'] = 'work') =>
  hive.createBee({ name, mode, workspace: join(dir, 'ws') });

const kinds = (id: string) => store.events(id).map((e) => e.kind);
const status = (id: string) => hive.views().find((b) => b.id === id)!.status;
const orderStatus = (o: OrderRow) => store.order(o.id)!.status;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hive-'));
  store = new Store(join(dir, 'hive.db'));
  fakes = [];
  open();
});

afterEach(() => {
  hive.shutdown();
  store.close();
  vi.useRealTimers();
});

describe('one bee', () => {
  it('runs an order and keeps every step in its history', async () => {
    const bee = add('Scout');
    const order = hive.order(bee.id, 'read notes');
    await flush();
    const f = fakes[0]!;
    expect(f.sent).toEqual(['read notes']);
    expect(status(bee.id)).toBe('busy');

    f.emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'haiku', tools: [], apiKeySource: 'none' });
    f.emit({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'On it' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'n' } }] },
    });
    f.emit({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'hi', is_error: false }] } });
    f.finish();

    expect(kinds(bee.id)).toEqual(['order', 'session', 'say', 'action', 'result', 'turn']);
    expect(orderStatus(order)).toBe('done');
    expect(status(bee.id)).toBe('idle');
    expect(store.bees()[0]!.sessionId).toBe('s1');
  });

  it('keeps the same process for the next order', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'one');
    await flush();
    fakes[0]!.finish();
    hive.order(bee.id, 'two');
    await flush();
    expect(fakes).toHaveLength(1);
    expect(fakes[0]!.sent).toEqual(['one', 'two']);
  });

  it('shows live typing without storing it', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'go');
    await flush();
    fakes[0]!.emit({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'he' } } });
    expect(pushed.at(-1)).toEqual({ ev: 'typing', beeId: bee.id, text: 'he' });
    expect(kinds(bee.id)).toEqual(['order']);
  });

  it('reports a failed turn and can work again afterwards', async () => {
    const bee = add('Scout');
    const o = hive.order(bee.id, 'go');
    await flush();
    fakes[0]!.finish({ subtype: 'error_during_execution', is_error: true, errors: ['usage limit reached'] });
    expect(orderStatus(o)).toBe('failed');
    expect(hive.views()[0]).toMatchObject({ status: 'error', detail: 'usage limit reached' });
    hive.order(bee.id, 'again');
    await flush();
    expect(status(bee.id)).toBe('busy');
  });

  it('marks the order failed when the bee cannot start', async () => {
    open({ start: async () => Promise.reject(new Error('not a subscription')) });
    const bee = add('Scout');
    const o = hive.order(bee.id, 'go');
    await flush();
    expect(orderStatus(o)).toBe('failed');
    expect(kinds(bee.id)).toEqual(['order', 'error']);
  });

  it('marks the order failed when the bee’s process dies', async () => {
    const bee = add('Scout');
    const o = hive.order(bee.id, 'go');
    await flush();
    fakes[0]!.hooks.onExit(new Error('crashed'));
    expect(orderStatus(o)).toBe('failed');
    expect(status(bee.id)).toBe('error');
    hive.order(bee.id, 'again');
    await flush();
    expect(fakes).toHaveLength(2);
  });

  it('ends a bee that acts without an order', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'go');
    await flush();
    fakes[0]!.finish();
    fakes[0]!.emit({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } });
    expect(fakes[0]!.closed).toBe(true);
    expect(kinds(bee.id)).toEqual(['order', 'turn', 'note', 'action']);
    expect(status(bee.id)).toBe('off');
  });

  it('rejects duplicate names, unknown models, and changes while working', async () => {
    const bee = add('Scout');
    expect(() => add('scout')).toThrow(/already/);
    expect(() => hive.createBee({ name: 'X', model: 'gpt', workspace: join(dir, 'ws') })).toThrow(/model/);
    hive.order(bee.id, 'go');
    expect(() => hive.updateBee(bee.id, { mode: 'look' })).toThrow(/Stop/);
    expect(() => hive.removeBee(bee.id)).toThrow(/Stop/);
  });

  it('puts an unused bee to sleep and wakes it with its memory', async () => {
    open({ idleMs: 5 });
    const bee = add('Scout');
    hive.order(bee.id, 'one');
    await flush();
    fakes[0]!.emit({ type: 'system', subtype: 'init', session_id: 's9' });
    fakes[0]!.finish();
    await new Promise((r) => setTimeout(r, 25));
    expect(fakes[0]!.closed).toBe(true);
    expect(status(bee.id)).toBe('off');
    hive.order(bee.id, 'two');
    await flush();
    expect(fakes[1]!.bee.sessionId).toBe('s9');
  });

  it('starts fresh, once, when saved memory is gone', async () => {
    const bee = add('Scout');
    store.saveBee({ ...store.bees()[0]!, sessionId: 'old' });
    open();
    const o = hive.order(bee.id, 'go');
    await flush();
    expect(fakes[0]!.bee.sessionId).toBe('old');
    fakes[0]!.hooks.onExit(new Error('No conversation found with session ID: old'));
    await flush();
    expect(fakes[1]!.bee.sessionId).toBeNull();
    expect(fakes[1]!.sent).toEqual(['go']);
    expect(kinds(bee.id)).toContain('note');
    fakes[1]!.finish();
    expect(orderStatus(o)).toBe('done');
  });
});

describe('order of work', () => {
  const o = (id: number, beeId: string, priority: number): OrderRow => ({
    id, beeId, priority, source: 'you', text: '', status: 'queued', createdAt: 0, startedAt: null, endedAt: null, taskId: null, planId: null, planFirst: false,
  });

  it('prefers priority, then age, and skips busy bees', () => {
    const orders = [o(1, 'a', 0), o(2, 'a', 1), o(3, 'b', 1), o(4, 'c', 2)];
    expect(pickNext(orders, new Set())!.id).toBe(4);
    expect(pickNext(orders, new Set(['c']))!.id).toBe(2);
    expect(pickNext(orders, new Set(['c', 'a']))!.id).toBe(3);
    expect(pickNext(orders, new Set(['a', 'b', 'c']))).toBeNull();
  });

  it('runs your order before one another bee asked for earlier', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'first');
    await flush();
    hive.order(bee.id, 'from queen', { source: 'queen' });
    hive.order(bee.id, 'from you');
    fakes[0]!.finish();
    await flush();
    expect(fakes[0]!.sent).toEqual(['first', 'from you']);
  });

  it('does not let another bee claim "now"', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'first');
    await flush();
    hive.order(bee.id, 'queen now', { source: 'queen', now: true });
    expect(fakes[0]!.interrupts).toBe(0);
  });

  it('"stop and do now" interrupts and jumps the queue', async () => {
    const bee = add('Scout');
    const first = hive.order(bee.id, 'long');
    await flush();
    hive.order(bee.id, 'waiting');
    hive.order(bee.id, 'urgent', { now: true });
    expect(fakes[0]!.interrupts).toBe(1);
    expect(status(bee.id)).toBe('stopping');
    fakes[0]!.finish({ subtype: 'error_during_execution', is_error: true, errors: ['[internal] code'] });
    await flush();
    expect(orderStatus(first)).toBe('stopped');
    expect(fakes[0]!.sent).toEqual(['long', 'urgent']);
    expect(store.events(bee.id).find((e) => e.kind === 'turn')!.data).toMatchObject({ stopped: true, errors: [] });
  });

  it('never starts one bee twice and respects the limit', async () => {
    open({ maxRunning: 2 });
    const ids = ['A', 'B', 'C'].map((n) => add(n).id);
    for (const id of ids) {
      hive.order(id, 'x');
      hive.order(id, 'y');
    }
    await flush();
    expect(fakes.map((f) => f.bee.name)).toEqual(['A', 'B']);
    fakes[0]!.finish();
    await flush();
    expect(fakes[0]!.sent).toEqual(['x', 'y']);
    fakes[0]!.finish();
    await flush();
    expect(fakes.map((f) => f.bee.name)).toEqual(['A', 'B', 'C']);
  });

  it('can cancel a waiting order but not a running one', async () => {
    const bee = add('Scout');
    const a = hive.order(bee.id, 'a');
    const b = hive.order(bee.id, 'b');
    hive.cancelOrder(b.id);
    expect(orderStatus(b)).toBe('cancelled');
    expect(() => hive.cancelOrder(a.id)).toThrow();
  });

  it('drops waiting orders of a removed bee', async () => {
    open({ maxRunning: 1 });
    const a = add('A');
    const b = add('B');
    hive.order(a.id, 'x');
    const waiting = hive.order(b.id, 'y');
    hive.removeBee(b.id);
    expect(orderStatus(waiting)).toBe('cancelled');
  });
});

describe('stopping', () => {
  it('keeps waiting orders and moves on to them', async () => {
    const bee = add('Scout');
    const a = hive.order(bee.id, 'a');
    await flush();
    hive.order(bee.id, 'b');
    hive.stop(bee.id);
    fakes[0]!.finish({ subtype: 'error_during_execution', is_error: true });
    await flush();
    expect(orderStatus(a)).toBe('stopped');
    expect(fakes[0]!.sent).toEqual(['a', 'b']);
  });

  it('works even before the bee has finished starting', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    open({ start: async (b, h) => (await gate, startFake(b, h)) });
    const bee = add('Scout');
    const o = hive.order(bee.id, 'a');
    hive.stop(bee.id);
    release();
    await flush();
    expect(fakes[0]!.sent).toEqual([]);
    expect(orderStatus(o)).toBe('stopped');
  });

  it('ends the process when the stop request fails', async () => {
    const bee = add('Scout');
    const o = hive.order(bee.id, 'a');
    await flush();
    fakes[0]!.interruptFails = true;
    hive.stop(bee.id);
    await flush();
    expect(fakes[0]!.closed).toBe(true);
    expect(orderStatus(o)).toBe('stopped');
    expect(status(bee.id)).toBe('off');
  });

  it('ends the process when the bee ignores the stop', async () => {
    open({ stopMs: 10 });
    const bee = add('Scout');
    const o = hive.order(bee.id, 'a');
    await flush();
    hive.stop(bee.id);
    await new Promise((r) => setTimeout(r, 30));
    expect(fakes[0]!.closed).toBe(true);
    expect(orderStatus(o)).toBe('stopped');
  });

  it('never passes on an order that was stopped just before the bee heard it', async () => {
    let go = () => {};
    const heard: string[] = [];
    let hooks: DriverHooks | null = null;
    open({
      start: async (_, h) => {
        hooks = h;
        return {
          send: async (text, told) => {
            await new Promise<void>((r) => (go = r));
            if (!told.wanted()) return false;
            heard.push(text);
            return true;
          },
          interrupt: async () => {},
          close: () => {},
        };
      },
    });
    const bee = add('Scout');
    const o = hive.order(bee.id, 'a');
    await flush();
    expect(hooks!.judge('Read', { file_path: 'x' }).kind).toBe('allow');
    hive.stop(bee.id);
    expect(hooks!.judge('Read', { file_path: 'x' }).kind).toBe('deny'); // Even what it may always do.
    go();
    await flush();
    expect(heard).toEqual([]);
    expect(orderStatus(o)).toBe('stopped');
    expect(hooks!.judge('Read', { file_path: 'x' }).kind).toBe('deny'); // No order, no actions.
  });

  it('keeps working when another part of Beekeep fails to handle news', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    hive.on('finished', () => {
      throw new Error('broken listener');
    });
    const bee = add('Scout');
    const a = hive.order(bee.id, 'a');
    const b = hive.order(bee.id, 'b');
    await flush();
    fakes[0]!.finish();
    await flush();
    fakes[0]!.finish();
    await flush();
    expect([orderStatus(a), orderStatus(b)]).toEqual(['done', 'done']);
    quiet.mockRestore();
  });

  it('ignores late messages from a process that was ended', async () => {
    open({ stopMs: 10 });
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    hive.stop(bee.id);
    await new Promise((r) => setTimeout(r, 30));
    const before = kinds(bee.id).length;
    fakes[0]!.finish();
    fakes[0]!.hooks.onExit(new Error('late'));
    expect(kinds(bee.id)).toHaveLength(before);
  });
});

describe('approvals', () => {
  const askBash = (f: FakeBee, signal = new AbortController().signal) => f.hooks.ask('Bash', { command: 'ls' }, signal);

  it('waits for you, then passes on a yes', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const answer = askBash(fakes[0]!);
    expect(status(bee.id)).toBe('waiting');
    hive.decide(store.waitingApprovals()[0]!.id, true);
    expect(await answer).toMatchObject({ allow: true });
    expect(status(bee.id)).toBe('busy');
    expect(kinds(bee.id)).toEqual(['order', 'approval', 'decision']);
  });

  it('passes on a no, and an answer cannot be given twice', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const answer = askBash(fakes[0]!);
    const { id } = store.waitingApprovals()[0]!;
    hive.decide(id, false);
    expect(await answer).toMatchObject({ allow: false });
    expect(() => hive.decide(id, true)).toThrow(/no longer/);
  });

  it('refuses what is pending when you stop the bee, and anything asked after', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const answer = askBash(fakes[0]!);
    hive.stop(bee.id);
    expect(await answer).toMatchObject({ allow: false });
    expect(await askBash(fakes[0]!)).toMatchObject({ allow: false });
    expect(store.waitingApprovals()).toEqual([]);
  });

  it('withdraws the request when the bee gives up on it', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const ctl = new AbortController();
    const answer = askBash(fakes[0]!, ctl.signal);
    ctl.abort();
    expect(await answer).toMatchObject({ allow: false });
    expect(store.waitingApprovals()).toEqual([]);
    expect(status(bee.id)).toBe('busy');
  });

  it('stays waiting until every open request is answered', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const both = [askBash(fakes[0]!), askBash(fakes[0]!)];
    const [x, y] = store.waitingApprovals();
    hive.decide(x!.id, true);
    expect(status(bee.id)).toBe('waiting');
    hive.decide(y!.id, true);
    expect(status(bee.id)).toBe('busy');
    await Promise.all(both);
  });
});

describe('restart', () => {
  it('shows what was cut off, keeps the queue, and remembers the bee', async () => {
    const bee = add('Scout');
    const running = hive.order(bee.id, 'a');
    await flush();
    fakes[0]!.emit({ type: 'system', subtype: 'init', session_id: 's1' });
    void fakes[0]!.hooks.ask('Bash', { command: 'ls' }, new AbortController().signal);
    const waiting = hive.order(bee.id, 'b');

    // Same database, new server: as after kill -9.
    open();
    expect(orderStatus(running)).toBe('stopped');
    expect(store.waitingApprovals()).toEqual([]);
    expect(kinds(bee.id)).toEqual(['order', 'session', 'approval', 'note', 'decision']);
    expect(hive.views()[0]).toMatchObject({ name: 'Scout', sessionId: 's1', status: 'off' });
    // Nothing starts by itself after a crash; you say when.
    await flush();
    expect(fakes).toHaveLength(1);
    expect(orderStatus(waiting)).toBe('queued');
    hive.resume();
    await flush();
    expect(fakes[1]!.sent).toEqual(['b']);
  });
});

describe('history', () => {
  it('pages backwards', () => {
    for (let i = 0; i < 5; i++) store.addEvent('b', 'note', { i });
    const last = store.events('b', undefined, 2);
    expect(last.map((e) => e.data.i)).toEqual([3, 4]);
    expect(store.events('b', last[0]!.id, 2).map((e) => e.data.i)).toEqual([1, 2]);
  });
});

describe('standing permissions', () => {
  it('"always" is remembered, shown, and can be taken back', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const answer = fakes[0]!.hooks.ask('Bash', { command: 'ls' }, new AbortController().signal);
    hive.decide(store.waitingApprovals()[0]!.id, true, { always: true });
    expect(await answer).toMatchObject({ allow: true });
    expect(fakes[0]!.hooks.judge('Bash', { command: 'ls' }).kind).toBe('allow');
    expect(fakes[0]!.hooks.judge('Bash', { command: 'ls -a' }).kind).toBe('ask');
    fakes[0]!.finish();
    // The window can take a permission away, but never add one.
    hive.updateBee(bee.id, { grants: [{ tool: 'Bash', match: 'anything' }] });
    expect(hive.view(bee.id).grants).toEqual([]);
  });

  it('refuses "always" where it would be too broad', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    void fakes[0]!.hooks.ask('Write', { file_path: '/etc/x' }, new AbortController().signal);
    const { id } = store.waitingApprovals()[0]!;
    expect(() => hive.decide(id, true, { always: true })).toThrow(/once/);
    expect(store.approval(id)!.status).toBe('waiting');
  });

  it('passes your answers and your reason back to the bee', async () => {
    const bee = add('Scout');
    hive.order(bee.id, 'a');
    await flush();
    const q = fakes[0]!.hooks.ask('AskUserQuestion', { questions: [] }, new AbortController().signal);
    hive.decide(store.waitingApprovals()[0]!.id, true, { answers: { 'Which?': 'Blue' } });
    expect(await q).toMatchObject({ allow: true, answers: { 'Which?': 'Blue' } });
    const no = fakes[0]!.hooks.ask('Bash', { command: 'x' }, new AbortController().signal);
    hive.decide(store.waitingApprovals()[0]!.id, false, { note: 'use make instead' });
    expect((await no).message).toContain('use make instead');
  });
});

describe('holding work back', () => {
  it('starts nothing while the gate is closed, and goes on when it opens', async () => {
    let why: string | null = 'limit';
    open({ gate: () => why });
    const bee = add('Scout');
    const o = hive.order(bee.id, 'a');
    await flush();
    expect(orderStatus(o)).toBe('queued');
    why = null;
    hive.resume();
    await flush();
    expect(orderStatus(o)).toBe('running');
  });
});
