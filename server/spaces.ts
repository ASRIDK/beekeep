import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { statSync } from 'node:fs';
import { defaultWorkspace, expandHome, prepareWorkspace } from './paths.ts';
import { gitCall } from './safegit.ts';
import type { Store } from './store.ts';
import type { SpaceInfo, SpaceRow } from './types.ts';

const EMPTY: SpaceInfo = { branch: null, changes: 0, pr: null, ports: [] };

function run(cmd: string, args: string[], cwd?: string, env = process.env, timeout = 8000): Promise<string> {
  return new Promise((done) => {
    execFile(
      cmd,
      args,
      { cwd, timeout, env, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => done(err ? '' : String(out)),
    );
  });
}

/** A status check must not change the repository, wait for a password, or run what a folder's settings name. */
function status(folder: string): Promise<string> {
  try {
    const c = gitCall(folder, ['status', '--porcelain=v2', '--branch', '--ignore-submodules=all']);
    return run(c.command, c.args, folder, c.env);
  } catch {
    return Promise.resolve('');
  }
}

/** Branch and number of changed files from `git status --porcelain=v2 --branch`. */
export function readGitStatus(text: string): Pick<SpaceInfo, 'branch' | 'changes'> {
  const lines = text.split('\n').filter(Boolean);
  const head = lines.find((l) => l.startsWith('# branch.head '))?.slice(14) ?? null;
  return { branch: head, changes: lines.filter((l) => !l.startsWith('#')).length };
}

/** Listening ports from `lsof -F pn`, for the given processes. */
export function readPorts(text: string, pids: Set<number>): number[] {
  const ports = new Set<number>();
  let mine = false;
  for (const line of text.split('\n')) {
    if (line[0] === 'p') mine = pids.has(Number(line.slice(1)));
    if (line[0] === 'n' && mine) {
      const port = Number(/:(\d+)$/.exec(line)?.[1]);
      if (port) ports.add(port);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** All processes started by these, directly or not, from `ps -axo pid=,ppid=`. */
export function family(text: string, roots: number[]): Set<number> {
  const children = new Map<number, number[]>();
  for (const line of text.split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (pid && parent) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const all = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    for (const c of children.get(queue.pop()!) ?? []) {
      if (!all.has(c)) {
        all.add(c);
        queue.push(c);
      }
    }
  }
  return all;
}

/** Separate places to work, each with its own folder, panes, bees and terminals. */
export class Spaces extends EventEmitter {
  private store: Store;
  private pidsOf: (spaceId: string) => number[];
  private known = new Map<string, SpaceInfo>();
  private prAt = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(store: Store, pidsOf: (spaceId: string) => number[]) {
    super();
    this.store = store;
    this.pidsOf = pidsOf;
    if (store.spaces().length === 0) {
      store.saveSpace({ id: 'main', name: 'Main', folder: defaultWorkspace(), mark: 1, position: 0 });
      // One layout became one per space.
      const old = store.get('layout');
      if (old) {
        store.set('layout:main', old);
        store.unset('layout');
      }
    }
  }

  list(): SpaceRow[] {
    return this.store.spaces();
  }

  get(id: string): SpaceRow {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw new Error('No such space.');
    return s;
  }

  current(): string {
    const id = this.store.get('space');
    return this.list().some((s) => s.id === id) ? (id as string) : this.list()[0]!.id;
  }

  setCurrent(id: string): void {
    this.get(id);
    this.store.set('space', id);
    void this.refresh();
  }

  create(name: string, folder: string): SpaceRow {
    if (!name.trim()) throw new Error('Give the space a name.');
    const all = this.list();
    const space: SpaceRow = {
      id: randomUUID().slice(0, 8),
      name: name.trim(),
      folder: prepareWorkspace(folder),
      mark: (all.length + 1) % 5,
      position: Math.max(0, ...all.map((s) => s.position)) + 1,
    };
    this.store.saveSpace(space);
    this.push();
    return space;
  }

  update(id: string, change: { name?: string; folder?: string }): SpaceRow {
    const s = this.get(id);
    const next = {
      ...s,
      name: change.name?.trim() || s.name,
      folder: change.folder ? prepareWorkspace(change.folder) : s.folder,
    };
    this.store.saveSpace(next);
    this.push();
    return next;
  }

  remove(id: string): void {
    this.get(id);
    if (this.list().length === 1) throw new Error('This is the only space.');
    this.store.removeSpace(id);
    this.store.unset(`layout:${id}`);
    this.push();
  }

  info(): Record<string, SpaceInfo> {
    return Object.fromEntries(this.list().map((s) => [s.id, this.known.get(s.id) ?? EMPTY]));
  }

  start(anyoneThere: () => boolean, everyMs = 10_000): void {
    this.timer = setInterval(() => anyoneThere() && void this.refresh(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const [ps, lsof] = await Promise.all([
        run('/bin/ps', ['-axo', 'pid=,ppid=']),
        run('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pn']),
      ]);
      const before = JSON.stringify(this.info());
      for (const s of this.list()) {
        const folder = expandHome(s.folder);
        const exists = statSync(folder, { throwIfNoEntry: false })?.isDirectory();
        const git = exists
          ? readGitStatus(await status(folder))
          : { branch: null, changes: 0 };
        const old = this.known.get(s.id) ?? EMPTY;
        const pr = git.branch && s.id === this.current() ? await this.pr(s.id, folder, old) : git.branch ? old.pr : null;
        this.known.set(s.id, { ...git, pr, ports: readPorts(lsof, family(ps, this.pidsOf(s.id))) });
      }
      if (JSON.stringify(this.info()) !== before) this.emit('push', { ev: 'spaceInfo', spaceInfo: this.info() });
    } finally {
      this.busy = false;
    }
  }

  /** Asked rarely, because it goes over the network. */
  private async pr(id: string, folder: string, old: SpaceInfo): Promise<SpaceInfo['pr']> {
    if (Date.now() - (this.prAt.get(id) ?? 0) < 180_000) return old.pr;
    this.prAt.set(id, Date.now());
    const text = await run('gh', ['pr', 'view', '--json', 'number,state,url,isDraft,statusCheckRollup'], folder, { ...process.env, GIT_TERMINAL_PROMPT: '0' });
    try {
      const p = JSON.parse(text) as {
        number: number;
        state: string;
        url: string;
        isDraft: boolean;
        statusCheckRollup?: { conclusion?: string; state?: string; status?: string }[];
      };
      const marks = (p.statusCheckRollup ?? []).map((c) => (c.conclusion || c.state || c.status || '').toUpperCase());
      const checks = !marks.length
        ? null
        : marks.some((m) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(m))
          ? 'checks failed'
          : marks.every((m) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(m))
            ? 'checks passed'
            : 'checks running';
      return { number: p.number, state: p.isDraft ? 'draft' : p.state.toLowerCase(), url: p.url, checks };
    } catch {
      return null;
    }
  }

  push(): void {
    this.emit('push', { ev: 'spaces', spaces: this.list(), spaceInfo: this.info() });
  }
}
