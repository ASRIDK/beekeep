import { type ChildProcess, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const wardenUrl = new URL('../server/warden.ts', import.meta.url).href;

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

const until = async (ok: () => boolean, ms = 6000) => {
  for (let t = 0; t < ms && !ok(); t += 50) await new Promise((r) => setTimeout(r, 50));
  return ok();
};

/** A stand-in server: starts a warden and two "bees", prints their process numbers. */
function server(): Promise<{ proc: ChildProcess; watched: number; unwatched: number }> {
  const code = `
    const { Warden } = await import(${JSON.stringify(wardenUrl)});
    const { spawn } = await import('node:child_process');
    const w = new Warden('/bin/sleep');
    const quiet = { stdio: 'ignore', detached: true };
    const a = spawn('/bin/sleep', ['60'], quiet);
    const b = spawn('/bin/sleep', ['60'], quiet);
    w.watch(a);
    setTimeout(() => console.log(a.pid, b.pid), 600);
    setInterval(() => {}, 1000);
  `;
  const proc = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return new Promise((resolve) => {
    proc.stdout!.once('data', (d) => {
      const [watched, unwatched] = String(d).trim().split(' ').map(Number);
      resolve({ proc, watched: watched!, unwatched: unwatched! });
    });
  });
}

it('ends bees when the server is killed outright, and nothing else', async () => {
  const s = await server();
  expect(gone(s.watched)).toBe(false);
  s.proc.kill('SIGKILL');
  expect(await until(() => gone(s.watched))).toBe(true);
  expect(gone(s.unwatched)).toBe(false);
  process.kill(s.unwatched);
}, 15_000);
