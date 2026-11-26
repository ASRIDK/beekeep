import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellEnv } from './env.ts';
import { hiveHome } from './paths.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const home = hiveHome();
const logFile = join(home, 'server.log');
const dist = process.env.BEEKEEP_DIST ?? join(root, 'dist');

interface Server {
  pid: number;
  port: number;
  token: string;
}

/** The running server, if it really answers. */
async function running(): Promise<Server | null> {
  try {
    const s = JSON.parse(readFileSync(join(home, 'server.json'), 'utf8')) as Server;
    const res = await fetch(`http://127.0.0.1:${s.port}/health`, { signal: AbortSignal.timeout(2000) });
    return (await res.text()) === 'hive' ? s : null;
  } catch {
    return null;
  }
}

/** When anything the window is built from last changed. */
function newest(dir: string): number {
  return Math.max(
    0,
    ...readdirSync(dir, { withFileTypes: true }).map((e) =>
      e.isDirectory() ? newest(join(dir, e.name)) : statSync(join(dir, e.name)).mtimeMs,
    ),
  );
}

async function launch(): Promise<Server> {
  const page = join(dist, 'index.html');
  if (!existsSync(page) || (!process.env.BEEKEEP_DIST && statSync(page).mtimeMs < newest(join(root, 'web')))) {
    console.log('Building the window.');
    const built = spawnSync('npm', ['run', '-s', 'build'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    if (built.status !== 0) throw new Error('The window could not be built.');
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const log = openSync(logFile, 'a', 0o600);
  const child = spawn(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', join(root, 'server/main.ts')],
    { cwd: root, detached: true, stdio: ['ignore', log, log], env: shellEnv(process.env) },
  );
  let died = false;
  child.on('exit', () => (died = true));
  child.unref();
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = await running();
    if (s) return s;
    if (died) break;
  }
  const tail = readFileSync(logFile, 'utf8').trim().split('\n').slice(-3).join('\n');
  throw new Error(`Beekeep did not start.\n${tail}`);
}

/** A link that works once, for one minute. The secret itself never appears in it. */
async function link(s: Server): Promise<string> {
  const { code } = (await post(s, '/code')) as { code: string };
  return `http://127.0.0.1:${s.port}/#c=${code}`;
}

async function post(s: Server, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${s.port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${s.token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `Beekeep answered ${res.status}.`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** One request to the running hive. */
async function api(op: string, args: unknown = {}): Promise<unknown> {
  const s = await running();
  if (!s) throw new Error('Beekeep is not running. Start it with: hive');
  return post(s, '/api', { op, args });
}

const appPath = join(homedir(), 'Applications/Beekeep.app');

function openWindow(url: string): void {
  if (existsSync(appPath)) {
    spawn('open', ['-a', appPath, '--args', url], { stdio: 'ignore', detached: true }).unref();
    return;
  }
  const chrome = '/Applications/Google Chrome.app';
  const args = existsSync(chrome) ? ['-na', 'Google Chrome', '--args', `--app=${url}`] : [url];
  spawn('open', args, { stdio: 'ignore', detached: true }).unref();
}

const HELP = `beekeep                          open the window (starts Beekeep if needed)
beekeep start | stop | status    run it without a window, stop it, or check on it
beekeep link                     a one-time link for a browser of your choice
beekeep logs                     the server log
beekeep app                      build the Mac app into ~/Applications

beekeep bees                     list the bees
beekeep order <bee> <text>       give an order (waits behind your own)
beekeep check <order>            state and report of an order
beekeep plans                    the queens' plans
beekeep board [topic]            read the shared board
beekeep post <topic> <text>      put a note on the board
beekeep notify <title> [text]    show a notice (works from any script)
beekeep limits                   how much of your plan is left

beekeep terms                    list terminals
beekeep read <terminal> [lines]  read a terminal
beekeep type <terminal> <text>   type into a terminal and press Enter
hive new [folder] [--run cmd] open a terminal
beekeep claude [folder]          open a Claude Code pane
beekeep ssh <user@host[:port]>   open an SSH pane
hive browser <address>        open a browser pane
hive space <name> <folder>    make a space

beekeep mcp                      MCP server, for other Claude sessions:
                              claude mcp add hive -- ${join(root, 'bin/beekeep')} mcp`;

function show(out: unknown): void {
  if (typeof out === 'string') return console.log(out);
  if (Array.isArray(out)) {
    for (const row of out) {
      console.log(
        Object.values(row as object)
          .map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v ?? '')))
          .filter(Boolean)
          .join('  '),
      );
    }
    if (out.length === 0) console.log('Nothing.');
    return;
  }
  for (const [k, v] of Object.entries(out as object)) console.log(`${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`Missing: ${what}. See: hive help`);
  return value;
}

async function readAll(): Promise<string> {
  let out = '';
  for await (const chunk of process.stdin) out += chunk;
  return out;
}

async function main([command, ...rest]: string[]): Promise<void> {
  const words = rest.join(' ');
  switch (command) {
    case undefined:
    case 'open':
      return openWindow(await link((await running()) ?? (await launch())));
    case 'start':
      return console.log(`Beekeep is running on port ${((await running()) ?? (await launch())).port}.`);
    case 'link':
      return console.log(await link((await running()) ?? (await launch())));
    case 'status': {
      const s = await running();
      if (!s) return console.log('Beekeep is not running.');
      const open = await api('windows').catch(() => null); // An older server does not know.
      const seen = typeof open === 'number' ? `, ${open} ${open === 1 ? 'window' : 'windows'} open` : '';
      return console.log(`Beekeep is running on port ${s.port} (process ${s.pid})${seen}.`);
    }
    case 'stop': {
      const s = await running();
      if (!s) return console.log('Beekeep is not running.');
      await post(s, '/stop');
      return console.log('Beekeep stopped. Bees keep their memory.');
    }
    case 'logs':
      return console.log(existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-20_000) : 'No log yet.');
    case 'app': {
      const built = spawnSync('/bin/bash', [join(root, 'mac/build.sh'), appPath], { stdio: 'inherit' });
      process.exitCode = built.status ?? 1;
      return;
    }
    case 'bees':
      return show(await api('list_bees'));
    case 'order':
      return show(await api('send_order', { bee: need(rest[0], 'bee'), text: need(rest.slice(1).join(' '), 'text') }));
    case 'check':
      return show(await api('check_order', { order: Number(need(rest[0], 'order number')) }));
    case 'plans':
      return show(await api('list_plans'));
    case 'board':
      return show(await api('read_board', rest[0] ? { topic: words } : {}));
    case 'post':
      return show(await api('post', { topic: need(rest[0], 'topic'), text: need(rest.slice(1).join(' '), 'text') }));
    case 'notify':
      return show(
        await api('notify', { title: need(rest[0], 'title'), body: rest.slice(1).join(' '), term: process.env.BEEKEEP_TERM }),
      );
    case 'limits':
      return show(await api('guard'));
    case 'terms':
      return show(await api('list_terminals'));
    case 'read':
      return show(await api('read_terminal', { terminal: need(rest[0], 'terminal'), lines: rest[1] ? Number(rest[1]) : undefined }));
    case 'type':
      return show(await api('type', { terminal: need(rest[0], 'terminal'), text: rest.slice(1).join(' ') }));
    case 'new': {
      const at = rest.indexOf('--run');
      const run = at >= 0 ? rest.slice(at + 1).join(' ') : undefined;
      const folder = (at >= 0 ? rest.slice(0, at) : rest)[0];
      return show(await api('new_terminal', { cwd: folder ?? process.cwd(), run }));
    }
    case 'claude':
      return show(await api('new_terminal', { cwd: rest[0] ?? process.cwd(), claude: true }));
    case 'ssh':
      return show(await api('new_terminal', { ssh: need(rest[0], 'user@host') }));
    case 'browser':
      return show(await api('open_browser', { url: need(rest[0], 'address') }));
    case 'space':
      return show(await api('new_space', { name: need(rest[0], 'name'), folder: need(rest[1], 'folder') }));
    case 'hook': {
      // Called by Claude panes. Must never get in Claude's way.
      try {
        const event = JSON.parse(await readAll()) as Record<string, unknown>;
        if (process.env.BEEKEEP_TERM) {
          const { hook_event_name, session_id, message } = event;
          await api('hook', { term: process.env.BEEKEEP_TERM, event: { hook_event_name, session_id, message } });
        }
      } catch {
        // Beekeep may be closed; that is fine.
      }
      return;
    }
    case 'mcp': {
      const { serve } = await import('./mcp.ts');
      return serve(api);
    }
    case 'help':
    case '--help':
      return console.log(HELP);
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
