// A stand-in for `codex app-server`: speaks the same protocol, and plays a short,
// fixed scene for each order, chosen by a word in it. Tests read what happened in
// the bee's history.
import { createInterface } from 'node:readline';

if (process.argv.includes('login')) {
  console.log(process.env.CODEX_HOME?.includes('logged-out') ? 'Not logged in' : 'Logged in using ChatGPT');
  process.exit(0);
}

let next = 1000;
const waiting = new Map();
const out = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => out({ method, params });
const ask = (method, params) =>
  new Promise((done) => {
    const id = next++;
    waiting.set(id, done);
    out({ id, method, params });
  });

let thread = null;
let resumed = false;
let turn = null;
let interrupted = null;
let stopEarly = false; // A stop can arrive before the scene has started.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const item = (type, extra) => ({ type, id: `${type}-${next++}`, ...extra });
const say = (text) => {
  const it = item('agentMessage', { text });
  notify('item/started', { item: { ...it, text: '' }, threadId: thread, turnId: turn });
  notify('item/agentMessage/delta', { threadId: thread, turnId: turn, itemId: it.id, delta: text });
  notify('item/completed', { item: it, threadId: thread, turnId: turn });
};
const end = (status = 'completed', error = null) => {
  notify('thread/tokenUsage/updated', { threadId: thread, turnId: turn, tokenUsage: { last: { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 30 } } });
  notify('turn/completed', { threadId: thread, turn: { id: turn, status, error, durationMs: 42, items: [] } });
  turn = null;
};

async function play(text) {
  if (text.includes('hello')) {
    say('Hello!');
  } else if (text.includes('run')) {
    const cmd = item('commandExecution', { command: "/bin/zsh -lc 'ls -la'", status: 'inProgress' });
    notify('item/started', { item: cmd, threadId: thread, turnId: turn });
    notify('item/completed', { item: { ...cmd, status: 'completed', exitCode: 0, aggregatedOutput: 'a.txt' }, threadId: thread, turnId: turn });
    say('Listed it.');
  } else if (text.includes('escalate') || text.includes('network')) {
    const cmd = item('commandExecution', { command: "/bin/zsh -lc 'curl https://example.org'", status: 'inProgress' });
    notify('item/started', { item: cmd, threadId: thread, turnId: turn });
    const net = text.includes('network') ? { networkApprovalContext: { host: 'example.org', protocol: 'https' } } : {};
    const r = await ask('item/commandExecution/requestApproval', {
      kind: 'command', threadId: thread, turnId: turn, itemId: cmd.id, startedAtMs: 0, environmentId: null,
      command: "/bin/zsh -lc 'curl https://example.org'", reason: 'needs the network', ...net,
    });
    const accepted = r.result?.decision === 'accept';
    notify('item/completed', { item: { ...cmd, status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null }, threadId: thread, turnId: turn });
    say(`decision: ${r.result?.decision ?? 'none'}`);
  } else if (text.includes('outside')) {
    const change = item('fileChange', { changes: [{ path: '/elsewhere/x.txt', kind: { type: 'add' }, diff: '+hi' }], status: 'inProgress' });
    notify('item/started', { item: change, threadId: thread, turnId: turn });
    const r = await ask('item/fileChange/requestApproval', { threadId: thread, turnId: turn, itemId: change.id, startedAtMs: 0, reason: 'outside' });
    notify('item/completed', { item: { ...change, status: r.result?.decision === 'accept' ? 'completed' : 'declined' }, threadId: thread, turnId: turn });
    say(`decision: ${r.result?.decision ?? 'none'}`);
  } else if (text.includes('question')) {
    const r = await ask('item/tool/requestUserInput', { threadId: thread, turnId: turn, itemId: 'q', questions: [] });
    say(r.error ? `refused: ${r.error.code}` : 'answered');
  } else if (text.includes('slow')) {
    if (!stopEarly) await new Promise((r) => (interrupted = r));
    stopEarly = false;
    return end('interrupted');
  } else if (text.includes('whoami')) {
    say(`thread: ${thread}, resumed: ${resumed}`);
  } else if (text.includes('fail')) {
    return end('failed', { message: 'model said no' });
  } else {
    say(`heard: ${text}`);
  }
  end();
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  const m = JSON.parse(line);
  if (m.id !== undefined && !m.method) {
    const done = waiting.get(m.id);
    waiting.delete(m.id);
    return done?.(m);
  }
  switch (m.method) {
    case 'initialize':
      return out({ id: m.id, result: { userAgent: 'fake', codexHome: '/x', platformFamily: 'unix', platformOs: 'macos' } });
    case 'initialized':
      return;
    case 'thread/start':
      thread = 'thread-new';
      return out({ id: m.id, result: { thread: { id: thread }, model: 'fake-model', sandbox: { type: m.params.sandbox } } });
    case 'thread/resume':
      if (m.params.threadId !== 'thread-new') return out({ id: m.id, error: { code: -1, message: 'no such thread' } });
      thread = 'thread-new';
      resumed = true;
      return out({ id: m.id, result: { thread: { id: thread }, model: 'fake-model-resumed' } });
    case 'turn/start': {
      turn = `turn-${next++}`;
      out({ id: m.id, result: { turn: { id: turn, status: 'inProgress', items: [] } } });
      notify('turn/started', { threadId: thread, turn: { id: turn } });
      const text = m.params.input[0].text;
      const policy = JSON.stringify(m.params.sandboxPolicy);
      if (text.includes('sandbox')) {
        say(`policy: ${policy}`);
        return end();
      }
      return void sleep(5).then(() => play(text));
    }
    case 'turn/interrupt':
      out({ id: m.id, result: {} });
      if (interrupted) {
        const done = interrupted;
        interrupted = null;
        return done();
      }
      stopEarly = true;
      return;
    default:
      return out({ id: m.id, error: { code: -32601, message: 'unknown' } });
  }
});
