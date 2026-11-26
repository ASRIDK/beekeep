// Small live check against the real Claude login (Haiku). Uses a little quota.
//   node scripts/live-check.ts
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sdkStarter } from '../server/driver.ts';
import { findClaude } from '../server/claude.ts';
import { Hive } from '../server/hive.ts';
import { Store } from '../server/store.ts';
import { NO_ABILITIES } from '../server/types.ts';
import { Warden } from '../server/warden.ts';

const [, self, phase = 'all', dirArg] = process.argv;
const dir = dirArg ?? realpathSync(mkdtempSync(join(tmpdir(), 'hive-live-')));
const ws = join(dir, 'ws');
const outside = join(dir, 'outside.txt');

let bad = 0;
function check(name: string, ok: boolean, extra: unknown = '') {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, extra);
}

function open() {
  const store = new Store(join(dir, 'hive.db'));
  const warden = new Warden(findClaude());
  const hive = new Hive({ store, start: sdkStarter(findClaude(), warden, (l) => console.log('   stderr:', l)) });
  hive.recover();
  return { store, hive };
}

/** Claude processes whose folder is this workspace. */
function beesIn(folder: string): string[] {
  const out = execSync("pgrep -f 'output-format stream-json' || true", { encoding: 'utf8' });
  return out.split('\n').filter((pid) => {
    if (!pid) return false;
    return execSync(`lsof -a -p ${Number(pid)} -d cwd -Fn 2>/dev/null || true`, { encoding: 'utf8' }).includes(`n${folder}`);
  });
}

type Opened = ReturnType<typeof open>;

/** Gives an order and waits for it to end, answering approvals on the way. */
function run({ store, hive }: Opened, beeId: string, text: string, allow: boolean, after?: () => void) {
  const asked: string[] = [];
  const o = hive.order(beeId, text);
  const from = Date.now();
  let called = false;
  return new Promise<{ status: string; asked: string[]; said: string; tokensIn: number }>((resolve, reject) => {
    const timer = setInterval(() => {
      for (const a of store.waitingApprovals()) {
        asked.push(a.tool);
        hive.decide(a.id, allow);
      }
      if (after && !called && Date.now() - from > 3500) {
        called = true;
        after();
      }
      const now = store.order(o.id)!;
      if (now.endedAt) {
        clearInterval(timer);
        const evs = store.events(beeId, undefined, 500);
        const mine = evs.slice(evs.findLastIndex((e) => e.kind === 'order' && e.data.orderId === o.id));
        resolve({
          status: now.status,
          asked,
          said: mine.filter((e) => e.kind === 'say').map((e) => e.data.text).join(' | '),
          tokensIn: Number(mine.findLast((e) => e.kind === 'turn')?.data.tokensIn ?? 0),
        });
      } else if (Date.now() - from > 90_000) {
        clearInterval(timer);
        reject(new Error(`Timed out: ${text}`));
      }
    }, 100);
  });
}

async function first() {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api03-fake-key-must-be-ignored';
  const h = open();
  const bee = h.hive.createBee({ name: 'Scout', mode: 'work', model: 'haiku', workspace: ws });

  let r = await run(h, bee.id, 'Reply with exactly: ready', false);
  check('own login used, stray API key ignored', r.status === 'done', r.said);
  // About 5,000 of this is the shell and its sandbox.
  check('work bee with a shell starts under 13,000 tokens', r.tokensIn > 0 && r.tokensIn < 13_000, `${r.tokensIn} tokens`);
  const light = h.hive.createBee({ name: 'Light', mode: 'work', model: 'haiku', workspace: ws, abilities: { ...NO_ABILITIES, shell: false } });
  const r0 = await run(h, light.id, 'Reply with exactly: ready', false);
  check('work bee without a shell starts under 8,500 tokens', r0.tokensIn > 0 && r0.tokensIn < 8_500, `${r0.tokensIn} tokens`);
  const session = h.store.events(bee.id).find((e) => e.kind === 'session');
  check('only the hive itself is connected', JSON.stringify((session?.data.mcp as { name: string }[]).map((m) => m.name)) === '["hive"]', session?.data.mcp);

  r = await run(h, bee.id, 'Write the word marigold into word.txt in your workspace, then reply done.', false);
  check('writes inside workspace without asking', existsSync(join(ws, 'word.txt')) && r.asked.length === 0, r.asked);

  r = await run(h, bee.id, 'Run this shell command with Bash: ls. If it is refused, reply refused.', false);
  check('even a read-only shell command asks first', r.asked.includes('Bash'), `${r.asked} / ${r.said.slice(0, 60)}`);

  r = await run(h, bee.id, 'Run this shell command with Bash: cat word.txt. Then tell me what it printed.', true);
  check('an approved command runs', r.asked.includes('Bash') && /marigold/.test(r.said), r.said.slice(0, 60));

  r = await run(h, bee.id, `Use the Write tool to create ${outside} containing x. If refused, reply refused.`, false);
  check('write outside asks, and no leaves no file', r.asked.includes('Write') && !existsSync(outside), r.asked);

  r = await run(h, bee.id, 'Use the Read tool to read /etc/hosts and report line 1. If refused, reply refused.', false);
  check('read outside asks first', r.asked.includes('Read'), r.asked);

  r = await run(h, bee.id, 'Write a 1500 word essay about bees as your reply. No tools.', false, () => h.hive.stop(bee.id));
  check('stop ends a running order', r.status === 'stopped', r.status);

  r = await run(h, bee.id, 'Reply with exactly: still here', false);
  check('bee still answers after a stop', /still here/.test(r.said), r.said);

  h.hive.order(bee.id, 'Write a 1500 word essay about honey as your reply. No tools.');
  await new Promise((res) => setTimeout(res, 2500));
  process.kill(process.pid, 'SIGKILL'); // Crash on purpose, mid-order.
}

async function second() {
  const h = open();
  const bee = h.hive.views()[0]!;
  const note = h.store.events(bee.id, undefined, 500).some((e) => e.kind === 'note');
  check('history says the order was cut off', note);
  const r = await run(h, bee.id, 'From memory, without tools: which word did you write into word.txt? One word.', false);
  check('memory survives kill -9', /marigold/i.test(r.said), r.said);
  const l = h.hive.createBee({ name: 'Looker', mode: 'look', model: 'haiku', workspace: ws });
  const r2 = await run(h, l.id, 'Create a file note.txt in your workspace. If you have no tool for that, reply: cannot.', true);
  check('look bee order under 7,000 tokens', r2.tokensIn > 0 && r2.tokensIn < 7000, `${r2.tokensIn} tokens`);
  check('a look bee cannot write', !existsSync(join(ws, 'note.txt')), r2.said.slice(0, 60));
  h.hive.shutdown();
  h.store.close();
}

if (phase === 'first') {
  await first();
} else if (phase === 'second') {
  await second();
} else {
  const a = spawnSync(process.execPath, [self!, 'first', dir], { stdio: 'inherit' });
  check('crash phase ended by kill -9', a.signal === 'SIGKILL', a.signal ?? a.status);
  await new Promise((r) => setTimeout(r, 4000));
  check('no bee outlives a crashed server', beesIn(ws).length === 0, beesIn(ws));
  const b = spawnSync(process.execPath, [self!, 'second', dir], { stdio: 'inherit' });
  if (b.status !== 0) bad += 1;
  console.log('workspace file:', existsSync(join(ws, 'word.txt')) && readFileSync(join(ws, 'word.txt'), 'utf8').trim());
  if (!bad) rmSync(dir, { recursive: true, force: true });
}
process.exit(bad ? 1 : 0);
