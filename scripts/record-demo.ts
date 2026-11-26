// Records a real session of the terminal screen, with real Claude, as an
// asciinema file (docs/demo.cast). Long waits are shortened; nothing else is changed.
// Run: node scripts/record-demo.ts   (uses a little of your Claude usage)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xterm from '@xterm/headless';
import { spawn } from 'node-pty';

const root = fileURLToPath(new URL('..', import.meta.url));
const base = '/tmp/beekeep-demo';
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });
const env = {
  ...process.env,
  BEEKEEP_HOME: join(base, '.beekeep'),
  BEEKEEP_WORK: join(base, 'project'),
  BEEKEEP_PORT: '3156',
  BEEKEEP_DIST: join(root, 'dist'),
} as Record<string, string>;
const bin = join(root, 'bin/beekeep');
execFileSync(bin, ['start'], { env, stdio: 'ignore' });

const cols = 110;
const rows = 30;
const IDLE = 1.2; // Longest pause kept, in seconds.
const frames: [number, string][] = [];
let clock = 0;
let last = Date.now();
const out = (data: string) => {
  const now = Date.now();
  clock += Math.min((now - last) / 1000, IDLE);
  last = now;
  frames.push([Number(clock.toFixed(3)), data]);
};

// The command being typed, as it would be in a shell.
out('\x1b[1;32m~/project\x1b[0m $ ');
for (const ch of 'beekeep') {
  await new Promise((r) => setTimeout(r, 90));
  out(ch);
}
await new Promise((r) => setTimeout(r, 400));
out('\r\n');

const term = new xterm.Terminal({ cols, rows, allowProposedApi: true });
const pty = spawn(bin, [], { cols, rows, env: { ...env, TERM: 'xterm-256color' } });
pty.onData((d) => {
  term.write(d);
  out(d);
});
const screen = () => {
  const b = term.buffer.active;
  return Array.from({ length: rows }, (_, i) => b.getLine(i)?.translateToString(true) ?? '').join('\n');
};
const wait = async (what: string | RegExp, ms = 180_000) => {
  for (let t = 0; t < ms; t += 100) {
    const s = screen();
    if (typeof what === 'string' ? s.includes(what) : what.test(s)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Never showed ${what}:\n${screen()}`);
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const press = async (...keys: string[]) => {
  for (const k of keys) {
    pty.write(k);
    await pause(k.length === 1 && /\w| /.test(k) ? 70 : 350);
  }
};

try {
  await wait('No bees yet.');
  await pause(1500);
  await press('\r');
  await wait('Worker 2');
  await pause(1500);
  // Keep both workers on screen beside whoever is chosen.
  await press('j', ' ', 'j', ' ');
  await pause(800);
  await press('k', 'k');
  await press('o', ...'Plan this: Worker 1 writes a haiku about bees to haiku.txt, Worker 2 writes a short limerick about honey to limerick.txt.', '\r');
  await wait('has a plan for you');
  await pause(1200);
  await press('p');
  await wait('y start it');
  await pause(2500);
  await press('y');
  const work = env.BEEKEEP_WORK!;
  for (let i = 0; i < 240 && !(existsSync(join(work, 'haiku.txt')) && existsSync(join(work, 'limerick.txt'))); i++) {
    if (screen().includes('y yes · n no')) {
      await pause(1500);
      await press('y');
    }
    await pause(500);
  }
  await wait(/Every task|Plan finished|done in/, 120_000);
  await pause(4000);
  // A question answered from the same place.
  await press('j');
  await press('o', ...'What is the title of https://example.com ? Answer in five words.', '\r');
  await wait('y yes · n no');
  await pause(2500);
  await press('y');
  await wait(/Example Domain/i);
  await pause(3000);
  await pause(500);
} finally {
  pty.kill();
  execFileSync(bin, ['stop'], { env, stdio: 'ignore' });
}

mkdirSync(join(root, 'docs'), { recursive: true });
const header = { version: 2, width: cols, height: rows, env: { TERM: 'xterm-256color' } };
writeFileSync(join(root, 'docs/demo.cast'), [JSON.stringify(header), ...frames.map((f) => JSON.stringify([f[0], 'o', f[1]]))].join('\n') + '\n');
console.log(`Recorded ${clock.toFixed(1)} s in docs/demo.cast`);
process.exit(0);
