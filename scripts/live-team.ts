// A live queen leading two workers (Haiku). Uses some quota.
//   node scripts/live-team.ts
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../server/assemble.ts';
import { findClaude } from '../server/claude.ts';
import { sdkStarter } from '../server/driver.ts';
import { Warden } from '../server/warden.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-team-')));
const ws = join(dir, 'ws');
process.env.BEEKEEP_WORK = ws;
const warden = new Warden();
const ctx = assemble({
  file: join(dir, 'hive.db'),
  hiveCommand: '/bin/echo',
  quotaTool: null,
  alert: () => {},
  start: sdkStarter(findClaude(), warden, (l) => console.log('   stderr:', l)),
});

let bad = 0;
function check(name: string, ok: boolean, extra: unknown = '') {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, extra);
}

const queen = ctx.hive.createBee({ name: 'Queen', kind: 'queen', model: 'haiku', workspace: ws });
ctx.hive.createBee({ name: 'Worker 1', model: 'haiku', workspace: ws });
ctx.hive.createBee({ name: 'Worker 2', model: 'haiku', workspace: ws });

ctx.hive.on('push', (m) => {
  if (m.ev !== 'event') return;
  const who = ctx.team.nameOf(m.event.beeId);
  const d = m.event.data;
  if (m.event.kind === 'action') console.log(`   ${who}: ${d.tool} ${JSON.stringify(d.input).slice(0, 100)}`);
  if (m.event.kind === 'say') console.log(`   ${who} says: ${String(d.text).slice(0, 160).replaceAll('\n', ' ')}`);
});

const until = async (ok: () => boolean, ms: number) => {
  const t = Date.now();
  while (!ok() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 200));
  return ok();
};
const plan = () => ctx.store.plans().at(-1);

ctx.hive.order(queen.id, 'I want Worker 1 and Worker 2 to create a small one-page landing page for a landscaping business: content.txt with the text, and index.html using it. Keep it short: hero, three services, contact. Use placeholders for the business name and phone.');
check('queen proposes a plan instead of doing the work', await until(() => plan()?.status === 'proposed', 120_000), plan()?.goal);
const needs = ctx.team.needs(plan()!.id).map((n) => n.name);
check('Beekeep sees that look-only workers need permission', needs.length > 0, needs);
check('nothing was written before the yes', !existsSync(join(ws, 'index.html')) && !existsSync(join(ws, 'content.txt')));
await until(() => ctx.hive.view(queen.id).currentOrderId === null, 60_000);

ctx.team.approve(plan()!.id, true);
check('plan runs to its end', await until(() => plan()!.status === 'done', 300_000), plan()!.status);
await until(() => ctx.store.openOrders().length === 0, 120_000);
const html = existsSync(join(ws, 'index.html')) ? readFileSync(join(ws, 'index.html'), 'utf8') : '';
check('the page exists', /<html/i.test(html) && html.length > 800, `${html.length} characters`);
check('the text exists', existsSync(join(ws, 'content.txt')));
const tasks = ctx.store.tasks(plan()!.id);
check('each task was handed in with a report', tasks.every((t) => t.status === 'done' && (t.report ?? '').length > 10), tasks.map((t) => `${t.key}:${t.status}`));
check('the queen checked and scored', tasks.some((t) => t.score !== null), tasks.map((t) => t.score));
check('links learned from it', ctx.store.links().some((l) => l.from === queen.id && l.weight !== 0.5), ctx.store.links().map((l) => l.weight));
const p = plan()!;
check('within its limits', p.used.orders <= p.limits.orders && p.used.wakeups <= p.limits.wakeups, p.used);
ctx.hive.shutdown();
warden.dismiss();
if (!bad) rmSync(dir, { recursive: true, force: true });
setTimeout(() => process.exit(bad ? 1 : 0), 500);
