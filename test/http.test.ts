import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { assemble } from '../server/assemble.ts';
import { createHttp, STOPPED } from '../server/http.ts';
import type { Context } from '../server/rpc.ts';
import { shellEnv } from '../server/env.ts';
import { readOscNotice, sshTarget } from '../server/terms.ts';

const TOKEN = 'secret-token';
let dir: string;
let server: Server;
let close: (goodbye?: boolean) => Promise<void>;
let port: number;
let ctx: Context;
let alerts: string[];
let stopped: boolean;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-')));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist/index.html'), '<h1>hive</h1>');
  writeFileSync(join(dir, 'private.txt'), 'private');
  process.env.BEEKEEP_WORK = join(dir, 'work');
  alerts = [];
  stopped = false;
  ctx = assemble({
    file: join(dir, 'hive.db'),
    hiveCommand: '/bin/echo',
    quotaTool: null,
    alert: (title) => void alerts.push(title),
    start: async () => ({ send: () => {}, interrupt: async () => {}, close: () => {} }),
  });
  ({ server, close } = createHttp({ ctx, token: TOKEN, dist: join(dir, 'dist'), onStop: () => (stopped = true) }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

afterEach(async () => {
  ctx.terms.shutdown();
  ctx.hive.shutdown();
  await close();
  ctx.store.close();
});

function http(method: string, path: string, headers: Record<string, string> = {}, body = '') {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: out, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const origin = () => `http://127.0.0.1:${port}`;
const bearer = { authorization: `Bearer ${TOKEN}` };

function socket(headers: Record<string, string> = { origin: origin() }, path = '/socket') {
  return new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
}

const closed = (ws: WebSocket) =>
  new Promise<number>((r) => {
    ws.on('close', (code) => r(code));
    ws.on('error', () => r(-1));
  });

/** An authorised window. */
async function connect() {
  const ws = socket();
  const pushes: Record<string, unknown>[] = [];
  const waiting = new Map<number, (m: { ok: boolean; data: any; error?: string }) => void>();
  let n = 0;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.re) waiting.get(m.re)?.(m);
    else pushes.push(m);
  });
  await new Promise((r, x) => (ws.on('open', r), ws.on('error', x)));
  const call = (op: string, args?: unknown, extra: object = {}) =>
    new Promise<{ ok: boolean; data: any; error?: string }>((resolve) => {
      const id = ++n;
      waiting.set(id, resolve);
      ws.send(JSON.stringify({ id, op, args, ...extra }));
    });
  await call('hello', undefined, { token: TOKEN });
  return { ws, call, pushes };
}

describe('who may connect', () => {
  it('serves the app with strict headers', async () => {
    const r = await http('GET', '/');
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });

  it('refuses a foreign Host (DNS rebinding)', async () => {
    expect((await http('GET', '/', { host: `evil.example:${port}` })).status).toBe(403);
    expect(await closed(socket({ origin: origin(), host: `evil.example:${port}` }))).toBe(-1);
  });

  it.each([['/../private.txt'], ['/%2e%2e/private.txt'], ['/..%2fprivate.txt'], ['//../private.txt']])(
    'does not serve files outside the app: %s',
    async (p) => {
      const r = await http('GET', p);
      expect(r.status).not.toBe(200);
      expect(r.body).not.toContain('private');
    },
  );

  it('survives a malformed address', async () => {
    expect((await http('GET', '/%')).status).toBe(500);
    expect((await http('GET', '/')).status).toBe(200);
  });

  it('refuses sockets from other websites, or with no origin', async () => {
    expect(await closed(socket({ origin: 'https://evil.example' }))).toBe(-1);
    expect(await closed(socket({ origin: 'http://127.0.0.1:1' }))).toBe(-1);
    expect(await closed(socket({}))).toBe(-1);
  });

  it('closes a socket that does not present the secret first', async () => {
    for (const first of [{ op: 'hello', token: 'wrong' }, { op: 'snapshot' }, { op: 'hello' }]) {
      const ws = socket();
      ws.on('open', () => ws.send(JSON.stringify(first)));
      expect(await closed(ws)).toBe(4401);
    }
  });

  it('gives launch codes and stops only for the command line holding the secret', async () => {
    for (const path of ['/code', '/stop', '/api']) {
      expect((await http('POST', path)).status).toBe(403);
      expect((await http('POST', path, { authorization: 'Bearer wrong' })).status).toBe(403);
      expect((await http('POST', path, { ...bearer, origin: origin() })).status).toBe(403);
    }
    expect(stopped).toBe(false);
    expect((await http('POST', '/stop', bearer)).status).toBe(200);
    expect(stopped).toBe(true);
  });

  it('trades a launch code for the secret exactly once, for this site only', async () => {
    const { code } = JSON.parse((await http('POST', '/code', bearer)).body);
    const claim = (o: Record<string, string>) => http('POST', '/claim', o, JSON.stringify({ code }));
    expect((await claim({ origin: 'https://evil.example' })).status).toBe(403);
    expect(JSON.parse((await claim({ origin: origin() })).body).token).toBe(TOKEN);
    expect((await claim({ origin: origin() })).status).toBe(403);
    expect((await http('POST', '/claim', { origin: origin() }, 'not json')).status).toBe(400);
  });
});

describe('requests', () => {
  it('creates a bee, takes an order, and tells the window', async () => {
    const { call, pushes } = await connect();
    const bee = (await call('bee.create', { name: 'Scout', workspace: join(dir, 'ws') })).data;
    await call('order.send', { beeId: bee.id, text: 'go' });
    const snap = (await call('snapshot')).data;
    expect(snap.bees[0]).toMatchObject({ name: 'Scout', status: 'busy' });
    expect(pushes.map((p) => p.ev)).toEqual(expect.arrayContaining(['bees', 'orders', 'event']));
  });

  it('cannot pretend an order came from a bee', async () => {
    const { call } = await connect();
    const bee = (await call('bee.create', { name: 'Scout', workspace: join(dir, 'ws') })).data;
    const r = await call('order.send', { beeId: bee.id, text: 'go', source: 'queen' });
    expect(r.data.source).toBe('you');
  });

  it('explains bad requests without dropping the window', async () => {
    const { call } = await connect();
    expect(await call('nope')).toMatchObject({ ok: false });
    expect(await call('constructor')).toMatchObject({ ok: false });
    expect(await call('order.send', { beeId: 5 })).toMatchObject({ ok: false });
    expect(await call('bee.create', { name: 'X', workspace: '/' })).toMatchObject({ ok: false });
    expect((await call('snapshot')).ok).toBe(true);
  });

  it.runIf(process.platform !== 'darwin')('says plainly that own git copies need macOS', async () => {
    const a = await connect();
    const made = await a.call('bee.create', { name: 'Anna', mode: 'work', workspace: dir, ownCopy: true });
    expect(made).toMatchObject({ ok: false, error: expect.stringMatching(/macOS/) });
    expect((await a.call('snapshot')).data.bees).toEqual([]);
  });

  it.runIf(process.platform === 'darwin')('gives a bee its own git copy, and takes it back', async () => {
    const git = (...args: string[]) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args]);
    process.env.BEEKEEP_COPIES = join(dir, 'copies');
    const project = join(dir, 'project');
    git('init', '-q', project);
    git('-C', project, 'commit', '-q', '--allow-empty', '-m', 'start');
    const a = await connect();
    const made = await a.call('bee.create', { name: 'Anna', mode: 'work', workspace: project, ownCopy: true });
    expect(made.data).toMatchObject({ origin: project, branch: expect.stringMatching(/^hive\/anna-/) });
    const id = made.data.id;
    expect((await a.call('bee.copy', { id })).data).toMatchObject({ commits: 0, changes: 0 });
    expect(await a.call('bee.bring', { id })).toMatchObject({ ok: false, error: expect.stringMatching(/no new commits/) });
    // The form sends the folder it shows, which is the copy's.
    const back = await a.call('bee.update', { id, ownCopy: false, workspace: made.data.workspace });
    expect(back.data).toMatchObject({ workspace: project, origin: null, branch: null });
    const again = await a.call('bee.update', { id, ownCopy: true, workspace: project });
    expect(again.data.origin).toBe(project);
    expect(again.data.workspace).not.toBe(made.data.workspace);
    expect(await a.call('bee.create', { name: 'Bob', mode: 'work', workspace: join(dir, 'plain'), ownCopy: true })).toMatchObject({ ok: false });
    expect((await a.call('snapshot')).data.bees.map((b: { name: string }) => b.name)).toEqual(['Anna']);
  }, 15_000);

  it('keeps the layout', async () => {
    const { call } = await connect();
    await call('layout.save', { space: 'main', layout: { a: [1] } });
    expect((await call('snapshot')).data.layouts).toEqual({ main: { a: [1] } });
  });
});

describe('terminals', () => {
  const until = async (ok: () => boolean) => {
    for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 25));
    expect(ok()).toBe(true);
  };

  it('runs a real shell, and shows earlier output to a window that opens later', async () => {
    const a = await connect();
    const t = (await a.call('term.open', { space: 'main', cwd: dir, cols: 80, rows: 24 })).data;
    await a.call('term.attach', { id: t.id });
    await a.call('term.write', { id: t.id, data: 'echo me"ado"w\r' });
    await until(() => a.pushes.some((p) => p.ev === 'term' && String(p.data).includes('meadow')));
    a.ws.close();

    const b = await connect();
    expect((await b.call('snapshot')).data.terminals).toMatchObject([{ id: t.id, alive: true }]);
    expect((await b.call('term.attach', { id: t.id })).data).toMatchObject({
      cols: 80,
      rows: 24,
      state: expect.stringContaining('meadow'),
    });
    await b.call('term.close', { id: t.id });
    expect((await b.call('snapshot')).data.terminals).toEqual([]);
  }, 15_000);

  it('shows the screen, not a replay, after a resize', async () => {
    const a = await connect();
    const t = (await a.call('term.open', { space: 'main', cwd: dir, cols: 100, rows: 24 })).data;
    await a.call('term.attach', { id: t.id });
    await a.call('term.write', { id: t.id, data: 'printf "x%.0s" {1..40}; clear; echo clean\r' });
    await until(() => a.pushes.some((p) => p.ev === 'term' && String(p.data).includes('clean')));
    await new Promise((r) => setTimeout(r, 300));
    await a.call('term.resize', { id: t.id, cols: 60, rows: 20 });
    const { data } = await a.call('term.attach', { id: t.id });
    expect(data.cols).toBe(60);
    expect(data.state).toContain('clean');
    expect(data.state).not.toContain('xxxx');
  }, 15_000);

  it('sends output only to windows watching that terminal', async () => {
    const a = await connect();
    const b = await connect();
    const t = (await a.call('term.open', { space: 'main', cols: 80, rows: 24 })).data;
    await a.call('term.attach', { id: t.id });
    await a.call('term.write', { id: t.id, data: 'echo hi\r' });
    await until(() => a.pushes.some((p) => p.ev === 'term'));
    expect(b.pushes.some((p) => p.ev === 'term')).toBe(false);
  }, 15_000);

  it('survives whatever a program prints', async () => {
    const a = await connect();
    const t = (await a.call('term.open', { space: 'main', cwd: dir, cols: 80, rows: 24 })).data;
    const codes = ['\\033]7;file://h/%E0%A4%A\\007', '\\033]7;file://h/%00\\007', '\\033]99;i=1:e=1;%%%\\007', '\\033]777;notify\\007', '\\033]9;\\007'];
    await a.call('term.write', { id: t.id, data: `printf '${codes.map((c) => c.replaceAll('%', '%%')).join('')}'; echo sur"viv"ed\r` });
    await until(() => ctx.terms.text(t.id).includes('survived'));
    expect((await a.call('snapshot')).data.terminals).toMatchObject([{ id: t.id, alive: true, cwd: dir }]);
  }, 15_000);

  it('explains a missing folder', async () => {
    const { call } = await connect();
    expect(await call('term.open', { space: 'main', cwd: '/no/such/place', cols: 80, rows: 24 })).toMatchObject({
      ok: false,
      error: expect.stringContaining('No such folder'),
    });
  });

  it('hides traces of an outer Claude session from shells', () => {
    const env = shellEnv({ PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_JOB_DIR: 'y' });
    expect(Object.keys(env).filter((k) => k.startsWith('CLAUDE'))).toEqual([]);
  });
});

describe('attention', () => {
  it('turns a program’s notification codes into notices, without alerts while you look', async () => {
    const { call, pushes } = await connect();
    await call('focus', { on: true });
    const t = (await call('term.open', { space: 'main', cwd: dir, cols: 80, rows: 24 })).data;
    await call('term.write', { id: t.id, data: "printf '\\033]777;notify;Build;finished\\007'\r" });
    for (let i = 0; i < 200 && !pushes.some((p) => p.ev === 'notices'); i++) await new Promise((r) => setTimeout(r, 25));
    const n = ctx.store.notices()[0]!;
    expect(n).toMatchObject({ title: 'Build', body: 'finished', source: `term:${t.id}`, kind: 'needs', read: false });
    expect(alerts).toEqual([]);
    await call('notice.read', { source: n.source });
    expect(ctx.store.notices().every((x) => x.read)).toBe(true);
  }, 15_000);

  it('alerts when no window is in front, and not over and over', async () => {
    const { call, ws } = await connect();
    await call('focus', { on: true });
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    for (const title of ['one', 'two']) ctx.notices.add({ kind: 'info', spaceId: 'main', source: 'hive', title, body: '' });
    expect(alerts).toEqual(['one']);
  });

  it('lets an SSH address be only an address', () => {
    expect(sshTarget('me@host.example')).toEqual(['--', 'me@host.example']);
    expect(sshTarget('box:2222')).toEqual(['-p', '2222', '--', 'box']);
    for (const bad of ['', '-oProxyCommand=sh', 'me@-oProxyCommand=x', 'a b', 'a;b', '$(x)', 'me@host:99999', 'a`b`', "a'b", '-l@x']) {
      expect(() => sshTarget(bad), bad).toThrow();
    }
  });

  it('reads the three codes in use', () => {
    expect(readOscNotice(9, 'Done')).toEqual({ title: '', body: 'Done' });
    expect(readOscNotice(9, '4;1;50')).toBeNull();
    expect(readOscNotice(777, 'notify;T;a;b')).toEqual({ title: 'T', body: 'a;b' });
    expect(readOscNotice(99, 'i=1;Hello')).toEqual({ title: '', body: 'Hello' });
  });
});

describe('the command line and other Claude sessions', () => {
  const api = async (op: string, args?: unknown) => http('POST', '/api', bearer, JSON.stringify({ op, args }));

  it('can look and give orders, which wait behind yours', async () => {
    const bee = ctx.hive.createBee({ name: 'Scout', workspace: join(dir, 'ws') });
    const r = JSON.parse((await api('send_order', { bee: 'scout', text: 'go' })).body);
    const o = ctx.store.order(r.order)!;
    expect(o).toMatchObject({ beeId: bee.id, source: 'outside', priority: 0 });
    expect(JSON.parse((await api('list_bees')).body)[0]).toMatchObject({ name: 'Scout', may: 'look' });
    expect((await api('send_order', { bee: 'nobody', text: 'x' })).status).toBe(400);
  });

  it('cannot approve, change a bee, approve plans, or lift limits', async () => {
    for (const op of ['approval.decide', 'bee.update', 'plan.approve', 'guard.override', 'command.trust', 'constructor', 'bee.create']) {
      expect((await api(op, { id: 1, allow: true })).status, op).toBe(400);
    }
  });

  it('takes reports from a Claude pane’s hooks and remembers its conversation', async () => {
    const t = ctx.terms.open({ spaceId: 'main', cwd: dir, cols: 80, rows: 24 });
    await api('hook', { term: t.id, event: { hook_event_name: 'UserPromptSubmit', session_id: 'abc-1' } });
    expect(ctx.terms.view(t.id)).toMatchObject({ agent: 'working', kind: 'claude' });
    await api('hook', { term: t.id, event: { hook_event_name: 'Notification', message: 'Allow Bash?' } });
    expect(ctx.terms.view(t.id).agent).toBe('needs you');
    expect(ctx.store.terms()[0]!.sessionId).toBe('abc-1');
    expect(ctx.store.notices()[0]).toMatchObject({ title: 'Claude needs you', body: 'Allow Bash?' });
  });
});

describe('stopping', () => {
  it('tells windows when Beekeep is stopped on purpose, and only then', async () => {
    const a = await connect();
    const code = new Promise<number>((r) => a.ws.on('close', (c) => r(c)));
    await close(true);
    expect(await code).toBe(STOPPED);
  });

  it('lets windows wait for Beekeep to come back after anything else', async () => {
    const a = await connect();
    const code = new Promise<number>((r) => a.ws.on('close', (c) => r(c)));
    await close();
    expect(await code).not.toBe(STOPPED);
  });
});

describe('restart', () => {
  it('connects an SSH pane again', async () => {
    const stub = join(dir, 'ssh');
    writeFileSync(stub, '#!/bin/sh\necho "args: $*"\nsleep 30\n', { mode: 0o755 });
    process.env.BEEKEEP_SSH = stub;
    try {
      const t = ctx.terms.open({ spaceId: 'main', kind: 'ssh', host: 'me@box.example:2222', cols: 80, rows: 24 });
      ctx.terms.shutdown();
      ctx.terms.restore();
      expect(ctx.terms.list()).toMatchObject([{ id: t.id, kind: 'ssh', host: 'me@box.example:2222', alive: true }]);
      for (let i = 0; i < 80 && !ctx.terms.text(t.id).includes('args:'); i++) await new Promise((r) => setTimeout(r, 25));
      expect(ctx.terms.text(t.id)).toContain('args: -p 2222 -- me@box.example');
    } finally {
      delete process.env.BEEKEEP_SSH;
    }
  }, 15_000);

  it('brings terminals back with their earlier output', async () => {
    const { call, pushes } = await connect();
    const t = (await call('term.open', { space: 'main', cwd: dir, cols: 80, rows: 24 })).data;
    await call('term.attach', { id: t.id });
    await call('term.write', { id: t.id, data: 'echo clo"ver"\r' });
    for (let i = 0; i < 200 && !pushes.some((p) => String(p.data).includes('clover')); i++) await new Promise((r) => setTimeout(r, 25));
    ctx.terms.shutdown();
    ctx.terms.restore();
    expect(ctx.terms.list()).toMatchObject([{ id: t.id, alive: true }]);
    const { state } = await ctx.terms.attach(t.id, () => {});
    expect(state).toContain('clover');
    ctx.terms.close(t.id);
    expect(ctx.store.terms()).toEqual([]);
  }, 15_000);
});
