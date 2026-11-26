// Runs the terminal screen inside a hidden terminal, presses keys, and checks what
// it shows. Uses no Claude: no order is sent. Run: node scripts/screen-check.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';

const root = fileURLToPath(new URL('..', import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'beekeep-screen-')));
const env = {
  ...process.env,
  BEEKEEP_HOME: join(dir, 'home'),
  BEEKEEP_WORK: join(dir, 'work'),
  BEEKEEP_PORT: process.env.BEEKEEP_PORT ?? '3159',
  BEEKEEP_DIST: process.env.BEEKEEP_DIST ?? join(root, 'dist'),
} as Record<string, string>;
const bin = join(root, 'bin/beekeep');
execFileSync(bin, ['start'], { env, stdio: 'ignore' });

const cols = 120;
const rows = 34;
const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const pty = spawn(bin, [], { cols, rows, env: { ...env, TERM: 'xterm-256color' } });
pty.onData((d) => term.write(d));

const screen = () => {
  const b = term.buffer.active;
  return Array.from({ length: rows }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n');
};
const wait = async (what: string | RegExp, ms = 8000) => {
  for (let t = 0; t < ms; t += 100) {
    const s = screen();
    if (typeof what === 'string' ? s.includes(what) : what.test(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Never showed ${what}:\n${screen()}`);
};
// One key at a time, as a person types; a burst arrives as one paste.
const press = async (...keys: string[]) => {
  for (const k of keys) {
    pty.write(k);
    await new Promise((r) => setTimeout(r, 120));
  }
};

let bad = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) bad += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n${extra}`}`);
};

try {
  let s = await wait('No bees yet.');
  check('first run offers a starter hive', s.includes('Press Enter for a starter hive'));
  await press('\r');
  s = await wait('Worker 2');
  check('Enter makes a queen and two workers', s.includes('♛ Queen') && s.includes('Worker 1') && s.includes('Your hive is ready'), s);
  await press('j', ' ', 'j', ' ');
  s = await wait(/Worker 1 · haiku[\s\S]*Worker 2 · haiku|Worker 2 · haiku[\s\S]*Worker 1 · haiku/);
  check('Space shows bees side by side', (s.match(/· haiku · work/g) ?? []).length >= 2, s);
  await press('+');
  s = await wait('New bee');
  await press(...Array(12).fill('\x7f'), ...'Scout', '\x1b[B', '\x1b[B', '\x1b[B', '\x1b[D', '\r');
  s = await wait('Scout joined the hive.');
  check('+ adds a bee from a small form', s.includes('Scout'), s);
  await press('o');
  s = await wait('Order for');
  check('o opens the order line for the chosen bee', s.includes('Enter send · Esc cancel'), s);
  await press('\x1b');
  await new Promise((r) => setTimeout(r, 200));
  await press('?');
  s = await wait('Keys');
  check('? lists the keys', s.includes('answer what a bee asks'), s);
  await press('x');
  await new Promise((r) => setTimeout(r, 200));

  if (process.env.LIVE === '1') {
    // Real Claude from here on: a question answered from the screen, then a plan.
    await press('k', 'k', 'k', 'k', 'j');
    await press('o', ...'Fetch https://example.com and tell me the page title, in five words or fewer.', '\r');
    s = await wait('y yes · n no', 120_000);
    check('a bee’s question shows in the one place for answers', /example\.com/.test(s), s);
    await press('y');
    s = await wait(/— done in/, 180_000);
    check('after a yes the bee finishes its order', /Example Domain/i.test(s), s);
    await press('k');
    await press('o', ...'Make a plan: Worker 1 writes hello.txt containing hi, Worker 2 writes bye.txt containing bye. Nothing else.', '\r');
    s = await wait('has a plan for you', 180_000);
    await press('p');
    s = await wait('y start it', 10_000);
    check('the queen’s plan shows its tasks before anything starts', /hello/i.test(s) && /bye/i.test(s), s);
    await press('y');
    const work = env.BEEKEEP_WORK!;
    for (let i = 0; i < 300 && !(existsSync(join(work, 'hello.txt')) && existsSync(join(work, 'bye.txt'))); i++) {
      if (screen().includes('y yes · n no')) await press('y');
      await new Promise((r) => setTimeout(r, 1000));
    }
    check('one yes runs the plan on both workers', existsSync(join(work, 'hello.txt')) && existsSync(join(work, 'bye.txt')), screen());
  }

  await press('q');
  for (let i = 0; i < 50 && !screen().includes('$') && !screen().includes('%'); i++) await new Promise((r) => setTimeout(r, 100));
  const bees = execFileSync(bin, ['bees'], { env, encoding: 'utf8' });
  check('q leaves the screen; the bees are still there', bees.includes('Scout') && bees.includes('Queen'), bees);
  execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
} catch (err) {
  bad += 1;
  console.log(`FAIL  ${(err as Error).message}`);
  try {
    execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
  } catch {
    // Already stopped.
  }
} finally {
  pty.kill();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
process.exit(bad ? 1 : 0);
