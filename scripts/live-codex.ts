// A real Codex bee, driven through beekeep: it works in its folder freely, and
// everything beyond its sandbox reaches the keeper. Uses a little of your Codex usage.
// Run: node scripts/live-codex.ts
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findCodex } from '../server/claude.ts';
import { codexCommand, codexStarter } from '../server/codex.ts';
import { Hive } from '../server/hive.ts';
import { Store } from '../server/store.ts';
import { NO_ABILITIES } from '../server/types.ts';
import { Warden } from '../server/warden.ts';

const codex = findCodex();
if (!codex) throw new Error('Codex is not installed.');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'beekeep-live-codex-')));
const ws = join(dir, 'ws');
const outside = join(dir, 'outside');
mkdirSync(ws);
mkdirSync(outside);
const store = new Store(join(dir, 'hive.db'));
const warden = new Warden();
const hive = new Hive({ store, start: codexStarter(codexCommand(codex), warden, (l) => console.error(l)) });

let bad = 0;
const check = (name: string, ok: boolean, extra: unknown = '') => {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, ok ? '' : extra);
};

async function run(beeId: string, text: string, allow: boolean) {
  const o = hive.order(beeId, text);
  const asked: string[] = [];
  for (let i = 0; i < 1800 && !store.order(o.id)!.endedAt; i++) {
    for (const a of store.waitingApprovals()) {
      asked.push(`${a.tool} ${JSON.stringify(a.input).slice(0, 120)}`);
      hive.decide(a.id, allow);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  const events = store.events(beeId, undefined, 500);
  const from = events.findLastIndex((e) => e.kind === 'order');
  const mine = events.slice(from);
  return { status: store.order(o.id)!.status, asked, said: mine.filter((e) => e.kind === 'say').map((e) => String(e.data.text)).join(' | ') };
}

try {
  const b = hive.createBee({ name: 'Codie', agent: 'codex', mode: 'work', workspace: ws, confined: false, abilities: { ...NO_ABILITIES, shell: true } });
  let r = await run(b.id, 'Create a file named hello.txt in your folder containing exactly: hi. Then reply with one word: done.', true);
  check('a Codex bee works in its folder', r.status === 'done' && readFileSync(join(ws, 'hello.txt'), 'utf8').trim() === 'hi', r);
  console.log('      it asked:', r.asked.length ? r.asked : 'nothing');

  r = await run(b.id, `Create the file ${join(outside, 'x.txt')} containing hi. It is outside your folder: ask for permission if you need it. Do not try another way if refused.`, false);
  check('writing outside its folder comes to the keeper', r.asked.length > 0, r);
  check('and a no keeps it out', !existsSync(join(outside, 'x.txt')), r);

  r = await run(b.id, 'Run this shell command and tell me what it printed: curl -sS -m 8 -o /dev/null -w "%{http_code}" https://httpbin.org/get . If it fails because of the sandbox, ask for permission once. Do not try another way if refused.', false);
  check('a command that reaches a website comes to the keeper first, and a no stops it', r.asked.some((a) => a.includes('curl')) && !/\b200\b/.test(r.said), r);
} finally {
  hive.shutdown();
  warden.dismiss();
  store.close();
  if (!bad) rmSync(dir, { recursive: true, force: true });
}
console.log(bad ? `${bad} FAILED` : 'ALL PASS');
setTimeout(() => process.exit(bad ? 1 : 0), 300);
