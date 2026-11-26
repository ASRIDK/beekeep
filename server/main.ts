import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './claude.ts';
import { sdkStarter } from './driver.ts';
import { createHttp } from './http.ts';
import { hiveHome } from './paths.ts';
import { assemble } from './assemble.ts';
import { Warden } from './warden.ts';

const home = hiveHome();
const port = Number(process.env.BEEKEEP_PORT ?? 3150);
// The project folder; compiled code sits one folder deeper, in lib/.
const root = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '..' : '../..', import.meta.url));
const dist = process.env.BEEKEEP_DIST ?? join(root, 'dist');

mkdirSync(home, { recursive: true, mode: 0o700 });

const token = randomBytes(32).toString('base64url');
const claude = findClaude();
const warden = new Warden(claude);
const ctx = assemble({
  file: join(home, 'hive.db'),
  start: sdkStarter(claude, warden, (line) => console.error(line)),
  hiveCommand: join(root, 'bin/beekeep'),
});
const { server, close, windows } = createHttp({ ctx, token, dist, onStop: () => stop(true) });

ctx.windows = windows;

const stateFile = join(home, 'server.json');

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : err.message);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  // Holding the port means no other Beekeep is running on this data.
  ctx.hive.recover();
  ctx.team.recover();
  ctx.terms.restore();
  ctx.guard.start();
  ctx.automations.start();
  ctx.spaces.start(() => windows() > 0);
  setInterval(() => void ctx.terms.track(), 15_000).unref();
  setInterval(() => ctx.terms.saveAll(), 60_000).unref();
  setInterval(() => ctx.team.tick(), 20_000).unref();
  // Readable by this user only: the token in here can run shells.
  rmSync(stateFile, { force: true });
  writeFileSync(stateFile, JSON.stringify({ pid: process.pid, port, token }), { mode: 0o600 });
  console.log(`Beekeep is running on http://127.0.0.1:${port}`);
});

let stopping = false;
/** With `goodbye`, as when the person runs beekeep stop, open windows close too. */
function stop(goodbye = false): void {
  if (stopping) return;
  stopping = true;
  ctx.automations.stop();
  ctx.guard.stop();
  ctx.spaces.stop();
  ctx.hive.shutdown();
  ctx.terms.shutdown();
  rmSync(stateFile, { force: true });
  const quit = () => {
    warden.dismiss();
    ctx.store.close();
    process.exit(0);
  };
  setTimeout(quit, 4000).unref();
  void Promise.all([close(goodbye), ctx.browsers.shutdown()]).then(quit);
}

// Something unforeseen: end in good order, with everything saved, rather than abruptly.
process.on('uncaughtException', (err) => {
  console.error(err);
  stop();
});
process.on('SIGTERM', () => stop());
process.on('SIGINT', () => stop());
