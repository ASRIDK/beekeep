// Live check of what bees can be given (Haiku). Uses some quota.
//   node scripts/live-abilities.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hive-ab-')));
const ws = join(dir, 'ws');
const home = join(dir, 'home');
mkdirSync(home);
mkdirSync(ws);
writeFileSync(join(home, 'secret.txt'), 'hive-secret-token');
process.env.BEEKEEP_HOME = home;
process.env.BEEKEEP_WORK = ws;
process.env.BEEKEEP_COPIES = join(dir, 'copies');
process.env.BEEKEEP_MCP_FILE = join(dir, 'mcp.json');
writeFileSync(
  process.env.BEEKEEP_MCP_FILE,
  JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [fileURLToPath(new URL('./stub-mcp.mjs', import.meta.url))] } } }),
);

const { assemble } = await import('../server/assemble.ts');
const { findClaude } = await import('../server/claude.ts');
const { sdkStarter } = await import('../server/driver.ts');
const { Warden } = await import('../server/warden.ts');
const { NO_ABILITIES } = await import('../server/types.ts');
type ApprovalRow = import('../server/types.ts').ApprovalRow;

const warden = new Warden(findClaude());
const ctx = assemble({
  file: join(home, 'hive.db'),
  hiveCommand: '/bin/echo',
  quotaTool: null,
  alert: () => {},
  start: sdkStarter(findClaude(), warden, (l) => console.log('   stderr:', l.slice(0, 200))),
});

let bad = 0;
let ran = 0;
function check(name: string, ok: boolean, extra: unknown = '') {
  ran += 1;
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`, extra);
}

type Decide = (a: ApprovalRow) => { allow: boolean; always?: boolean; answers?: Record<string, string> };

async function run(beeId: string, text: string, decide: Decide, opts: { planFirst?: boolean } = {}) {
  const asked: ApprovalRow[] = [];
  const o = ctx.hive.order(beeId, text, opts);
  const from = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 120));
    for (const a of ctx.store.waitingApprovals()) {
      asked.push(a);
      const d = decide(a);
      ctx.hive.decide(a.id, d.allow, d);
    }
    const now = ctx.store.order(o.id)!;
    if (now.endedAt || Date.now() - from > 120_000) {
      const evs = ctx.store.events(beeId, undefined, 500);
      const mine = evs.slice(evs.findLastIndex((e) => e.kind === 'order' && e.data.orderId === o.id));
      return {
        status: now.status,
        asked,
        acts: mine.filter((e) => e.kind === 'action').map((e) => String(e.data.tool)),
        results: mine.filter((e) => e.kind === 'result').map((e) => String(e.data.text).slice(0, 4000)),
        said: mine.filter((e) => e.kind === 'say' && !e.data.helper).map((e) => e.data.text).join(' | '),
        uuid: String(mine[0]?.data.uuid ?? ''),
        tokens: Number(mine.findLast((e) => e.kind === 'turn')?.data.tokensIn ?? 0),
      };
    }
  }
}

const yes: Decide = () => ({ allow: true });
const bee = (name: string, over: object = {}) => ctx.hive.createBee({ name, mode: 'work', model: 'haiku', workspace: ws, ...over });

const only = process.env.ONLY?.split(',');
const part = (name: string) => !only || only.includes(name);
let r: Awaited<ReturnType<typeof run>>;
const c = bee('Confined');
const q = bee('Asker', { abilities: { ...NO_ABILITIES, questions: true } });

if (part('shell')) {
const outside = join(dir, 'outside.txt');
r = await run(c.id, `Run exactly this with Bash, once: echo in > inside.txt; echo out > ${outside}; cat ${join(home, 'secret.txt')}; echo end. Then say what it printed. Do not try again another way.`, yes);
check('a confined command writes inside its folder', existsSync(join(ws, 'inside.txt')), r.asked.map((a) => a.reason));
check('and cannot write outside, even after a yes', !existsSync(outside), r.results[0]);
check('and cannot read Beekeep’s own secrets', !r.results.join(' ').includes('hive-secret-token'));
r = await run(c.id, 'Run exactly this with Bash, once: curl -sS -m 8 -o /dev/null -w "%{http_code}" https://example.com . Then say what it printed.', (a) => ({ allow: a.tool === 'Bash' }));
check('and cannot reach the internet without its own yes', !/\b200\b/.test(r.results[0] ?? ''), { asked: r.asked.map((a) => a.tool), got: r.results[0] });

}

if (part('copy')) {
const repo = join(dir, 'repo');
mkdirSync(repo);
const git = (...a: string[]) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' });
git('init', '-q', '-b', 'main');
writeFileSync(join(repo, 'a.txt'), 'one');
git('add', '-A');
git('commit', '-q', '-m', 'start');
const own = await ctx.hive.withCopy({ name: 'Copier', mode: 'work', model: 'haiku', workspace: repo });
r = await run(own.id, 'Write note.txt containing hi, then run exactly this with Bash: git -c user.name=t -c user.email=t@t add -A && git -c user.name=t -c user.email=t@t commit -q -m note. Then reply done.', yes);
check('a confined bee commits in its own copy', (await ctx.hive.copy(own.id))?.commits === 1, { state: await ctx.hive.copy(own.id), got: r.results.at(-1) });
check('and your checkout is untouched', !existsSync(join(repo, 'note.txt')) && git('status', '--porcelain') === '');
check('its work comes in as a branch', (await ctx.hive.bring(own.id)) === '1' && git('show', `${own.branch}:note.txt`).trim() === 'hi');
const head = git('rev-parse', 'main');
// The attack lies in a script the bee runs, as in a hostile project's tests.
writeFileSync(join(own.workspace, 'check.sh'), [
  `rm -rf ${repo}/.git/objects`, `echo x > ${repo}/a.txt`, `git -C ${repo} update-ref refs/heads/main main~1`,
  `git -C ${repo} branch planted`, 'echo x > .git/hooks/pre-commit', 'echo x >> .git/config',
  'mkdir -p e', 'echo x > e/config', 'echo ../e > .git/commondir',
  'mv .git .git-old', `ln -s ${repo}/.git .git`, 'ls -ld .git', 'echo step one over',
].join('\n'));
writeFileSync(join(own.workspace, 'check2.sh'), 'echo planted > .git/planted\nls .git\necho step two over\n');
r = await run(own.id, 'Run the project check, exactly this with Bash, once: sh check.sh 2>&1 . Then say done.', yes);
const one = r.results.join('\n');
r = await run(own.id, 'Run the second check, exactly this with Bash, once: sh check2.sh 2>&1 . Then say done.', yes);
const two = r.results.join('\n');
check('the attack really ran', one.includes('step one over') && two.includes('step two over'), `\n${one}\n--\n${two}`);
check('and it could not harm your repository, even by swapping its git folder',
  git('rev-parse', 'main') === head && git('fsck') === '' && git('status', '--porcelain') === '' && !git('branch').includes('planted') && !existsSync(join(repo, '.git/planted')));
check('nor plant hooks or settings in its copy', !existsSync(join(own.workspace, '.git/hooks/pre-commit')) && !existsSync(join(own.workspace, '.git/commondir')) && !readFileSync(join(own.workspace, '.git/config'), 'utf8').includes('\nx'));

const shared = bee('Shared', { workspace: repo });
const config = readFileSync(join(repo, '.git/config'), 'utf8');
writeFileSync(join(repo, 'check3.sh'), [
  'echo x > .git/hooks/pre-commit', 'echo x >> .git/config', 'echo ../e > .git/commondir', 'mkdir -p .git/modules/a', 'mv .git .git-old', 'echo step three over',
].join('\n'));
r = await run(shared.id, 'Run the third check, exactly this with Bash, once: sh check3.sh 2>&1 . Then say done.', yes);
check('a confined bee in your own folder cannot plant git hooks or settings either',
  r.results.join('\n').includes('step three over') && readFileSync(join(repo, '.git/config'), 'utf8') === config &&
    ['hooks/pre-commit', 'commondir', 'modules'].every((p) => !existsSync(join(repo, '.git', p))), r.results.join('\n'));
}

if (part('ask')) {
r = await run(q.id, 'Ask me with AskUserQuestion which colour I want, red or blue. Then reply with my answer only.', (a) =>
  a.tool === 'AskUserQuestion'
    ? { allow: true, answers: { [(a.input.questions as { question: string }[])[0]!.question]: 'Blue' } }
    : { allow: false },
);
check('a question is answered from Beekeep', /blue/i.test(r.said), r.said);

// Plan first
let before = true;
r = await run(q.id, 'Create plan.txt containing planned.', (a) => {
  if (a.tool === 'ExitPlanMode') before = existsSync(join(ws, 'plan.txt'));
  return { allow: true };
}, { planFirst: true });
check('plan first shows a plan and waits', r.asked.some((a) => a.tool === 'ExitPlanMode') && !before, r.asked.map((a) => a.tool));
check('then does it', existsSync(join(ws, 'plan.txt')));

}

if (part('undo')) {
await run(c.id, 'Write u.txt containing first. Reply done.', yes);
const second = await run(c.id, 'Change u.txt so it contains second. Reply done.', yes);
const changed = readFileSync(join(ws, 'u.txt'), 'utf8').trim();
await ctx.hive.undo(c.id, second.uuid).catch((e: Error) => console.log('   undo:', e.message));
check('undo puts files back', changed === 'second' && readFileSync(join(ws, 'u.txt'), 'utf8').trim() === 'first', readFileSync(join(ws, 'u.txt'), 'utf8').trim());

}

if (part('given')) {
const s = bee('Skilled', { abilities: { ...NO_ABILITIES, skills: ['caveman'], mcp: ['stub'] } });
r = await run(s.id, 'Use the caveman skill once with the Skill tool, then reply with the title of its rule 1 only.', yes);
check('a skill loads by itself', r.acts.includes('Skill') && /answer first/i.test(r.said), r.said.slice(0, 80));
r = await run(s.id, 'Use the stub MCP server’s word tool and reply with the word only.', yes);
check('an MCP server works and asks first', /amber/i.test(r.said) && r.asked.some((a) => a.tool === 'mcp__stub__word'), { asked: r.asked.map((a) => a.tool), said: r.said.slice(0, 60) });

}

if (part('browser')) {
const site = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<title>Shop</title><h1>Shop</h1><button onclick="document.querySelector(\'h1\').textContent=\'Sold 42\'">Buy</button>');
});
await new Promise<void>((ok) => site.listen(0, '127.0.0.1', ok));
const url = `http://127.0.0.1:${(site.address() as { port: number }).port}/`;
const b = bee('Surfer', { abilities: { ...NO_ABILITIES, browser: true } });
r = await run(b.id, `Open ${url} in your browser, click Buy, and reply with the heading shown afterwards only.`, () => ({ allow: true, always: true }));
check('a bee uses the browser', /Sold 42/.test(r.said), { asked: r.asked.map((a) => a.reason), said: r.said.slice(0, 80) });
check('one yes covers that site only', r.asked.length === 1 && ctx.hive.view(b.id).grants.length === 1, ctx.hive.view(b.id).grants);

site.close();
}

if (part('full')) {
const f = bee('Full', { mode: 'full' });
r = await run(f.id, 'Make a to-do list with the two items wash and dry using your to-do tool, then reply done.', yes);
check('a full bee has Claude Code’s other tools', r.acts.some((a) => /Todo|Task/.test(a)), { acts: r.acts, tokens: r.tokens });

}

ctx.hive.shutdown();
await ctx.browsers.shutdown();
warden.dismiss();
if (ran === 0) bad += 1; // Checking nothing proves nothing.
console.log(bad === 0 ? `ALL ${ran} PASS` : `${bad} FAILED of ${ran} run`);
if (!bad) rmSync(dir, { recursive: true, force: true });
setTimeout(() => process.exit(bad ? 1 : 0), 500);
