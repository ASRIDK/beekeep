import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { SerializeAddon } from '@xterm/addon-serialize';
import headless from '@xterm/headless';
import { spawn, type IPty } from 'node-pty';
import { shellEnv } from './env.ts';
import { expandHome, hiveHome } from './paths.ts';
import type { SavedTerm, Store } from './store.ts';
import type { TermKind, TermView } from './types.ts';

const SCROLLBACK = 2000;
const MAX_TERMS = 24;

interface Term {
  id: string;
  spaceId: string;
  kind: TermKind;
  cwd: string;
  host: string | null;
  pty: IPty | null;
  /** What the screen looks like right now, so a window opened later sees it correctly. */
  screen: headless.Terminal;
  serializer: SerializeAddon;
  title: string;
  agent: TermView['agent'];
  /** Claude panes: the conversation to come back to. */
  sessionId: string | null;
}

export interface Screen {
  cols: number;
  rows: number;
  state: string;
}

export interface OpenTerm {
  spaceId: string;
  kind?: TermKind;
  cwd?: string;
  host?: string;
  cols: number;
  rows: number;
  /** Typed into the shell once it is ready. */
  run?: string;
}

/** Programs can print anything, including paths that are not properly written. */
function decodePath(path: string): string | null {
  try {
    const text = decodeURIComponent(path);
    return text.includes('\0') ? null : text;
  } catch {
    return null;
  }
}

/** Arguments for ssh. The host must not be able to pass as an option or a command. */
export function sshTarget(raw: string): string[] {
  const host = raw.trim();
  const m = /^(?:([A-Za-z0-9_][\w.-]*)@)?([A-Za-z0-9][\w.-]*)(?::(\d{1,5}))?$/.exec(host);
  if (!m) throw new Error('Write the address as user@host or user@host:port.');
  const [, user, name, port] = m;
  if (port && Number(port) > 65_535) throw new Error('That port does not exist.');
  return [...(port ? ['-p', port] : []), '--', user ? `${user}@${name}` : name!];
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

/** What a program asked to show, from the terminal notification codes in use. */
export function readOscNotice(code: number, data: string): { title: string; body: string } | null {
  if (code === 9) {
    if (/^\d+(;|$)/.test(data)) return null; // Progress reports share this code.
    return data.trim() ? { title: '', body: data } : null;
  }
  if (code === 777) {
    const [verb, title = '', ...rest] = data.split(';');
    return verb === 'notify' ? { title, body: rest.join(';') } : null;
  }
  if (code === 99) {
    const at = data.indexOf(';');
    const body = at < 0 ? data : data.slice(at + 1);
    return body.trim() ? { title: '', body } : null;
  }
  return null;
}

/** Real shells that keep running when the window closes. Emits 'data', 'list' and 'notice'. */
export class Terms extends EventEmitter {
  private terms = new Map<string, Term>();
  private store: Store;
  private hiveCommand: string;

  constructor(store: Store, hiveCommand: string) {
    super();
    this.store = store;
    this.hiveCommand = hiveCommand;
  }

  list(): TermView[] {
    return [...this.terms.values()].map((t) => ({
      id: t.id,
      spaceId: t.spaceId,
      kind: t.kind,
      cwd: t.cwd,
      host: t.host,
      title: t.host ?? (t.title || (t.cwd === homedir() ? '~' : basename(t.cwd))),
      alive: t.pty !== null,
      agent: t.agent,
    }));
  }

  pids(spaceId: string): number[] {
    return [...this.terms.values()].filter((t) => t.spaceId === spaceId && t.pty).map((t) => t.pty!.pid);
  }

  open(o: OpenTerm): TermView {
    const cwd = o.cwd?.trim() ? expandHome(o.cwd.trim()) : homedir();
    if (!statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`No such folder: ${cwd}`);
    return this.begin({
      id: randomUUID().slice(0, 8),
      spaceId: o.spaceId,
      kind: o.kind ?? 'shell',
      cwd,
      host: o.kind === 'ssh' ? sshTarget(o.host ?? '') && o.host!.trim() : null,
      sessionId: null,
      screen: '',
      cols: o.cols,
      rows: o.rows,
      run: o.run,
    });
  }

  /** Brings back the terminals of the last run: same place, earlier output, and Claude conversations. */
  restore(): void {
    for (const t of this.store.terms()) {
      const cwd = statSync(t.cwd, { throwIfNoEntry: false })?.isDirectory() ? t.cwd : homedir();
      try {
        this.begin({ ...t, cwd });
      } catch {
        this.store.removeTerm(t.id);
      }
    }
  }

  private begin(t: SavedTerm & { run?: string }): TermView {
    if (this.terms.size >= MAX_TERMS) throw new Error(`At most ${MAX_TERMS} terminals can be open.`);
    const ssh = t.kind === 'ssh' ? sshTarget(t.host ?? '') : null;
    const shell = ssh ? (process.env.BEEKEEP_SSH ?? '/usr/bin/ssh') : (process.env.SHELL ?? '/bin/zsh');
    const args = ssh ?? (t.kind === 'claude' ? ['-l', '-i', '-c', `${this.claudeCommand(t.sessionId)}; exec ${quote(shell)} -l`] : ['-l']);
    const pty = spawn(shell, args, {
      name: 'xterm-256color',
      cwd: t.cwd,
      cols: t.cols,
      rows: t.rows,
      env: { ...shellEnv(process.env), BEEKEEP_TERM: t.id, BEEKEEP_SPACE: t.spaceId, HIVE: this.hiveCommand },
    });
    const screen = new headless.Terminal({ cols: t.cols, rows: t.rows, scrollback: SCROLLBACK, allowProposedApi: true });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const term: Term = {
      id: t.id,
      spaceId: t.spaceId,
      kind: t.kind,
      cwd: t.cwd,
      host: t.host,
      pty,
      screen,
      serializer,
      title: '',
      agent: t.kind === 'claude' ? 'ready' : null,
      sessionId: t.sessionId,
    };
    this.terms.set(term.id, term);
    if (t.screen) screen.write(`${t.screen}\r\n\x1b[0m\x1b[2m[earlier session, before Beekeep restarted]\x1b[0m\r\n`);
    for (const code of [9, 99, 777]) {
      screen.parser.registerOscHandler(code, (data) => {
        const n = readOscNotice(code, data);
        if (n) this.emit('notice', { term: this.view(term.id), ...n });
        return true;
      });
    }
    // Programs announce their folder and title this way.
    screen.parser.registerOscHandler(7, (data) => {
      const path = /^file:\/\/[^/]*(\/.*)$/.exec(data)?.[1];
      if (path && !term.host) this.setCwd(term, decodePath(path) ?? term.cwd);
      return true;
    });
    screen.onTitleChange((title) => {
      term.title = title.slice(0, 80);
      this.emit('list');
    });
    // Windows get output only once it is part of the screen, so a window that
    // attaches in between neither misses nor repeats any of it.
    pty.onData((data) => screen.write(data, () => this.emit('data', term.id, data)));
    pty.onExit(() => {
      if (term.pty !== pty) return;
      term.pty = null;
      term.agent = null;
      this.store.removeTerm(term.id);
      this.emit('list');
    });
    if (t.run) {
      const text = t.run;
      setTimeout(() => term.pty === pty && pty.write(`${text}\r`), 600);
    }
    this.save(term);
    this.emit('list');
    return this.view(term.id);
  }

  private claudeCommand(sessionId: string | null): string {
    const dir = hiveHome();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const hook = { type: 'command', command: `${quote(this.hiveCommand)} hook`, timeout: 10 };
    const each = [{ hooks: [hook] }];
    const settings = join(dir, 'claude-settings.json');
    const mcp = join(dir, 'claude-mcp.json');
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { SessionStart: each, UserPromptSubmit: each, Notification: each, Stop: each } }),
      { mode: 0o600 },
    );
    writeFileSync(mcp, JSON.stringify({ mcpServers: { hive: { command: this.hiveCommand, args: ['mcp'] } } }), { mode: 0o600 });
    const resume = sessionId && /^[\w-]+$/.test(sessionId) ? ` --resume ${sessionId}` : '';
    return `claude --settings ${quote(settings)} --mcp-config ${quote(mcp)}${resume}`;
  }

  /** What a Claude pane's hooks report about it. */
  hook(id: string, event: { hook_event_name?: string; session_id?: string; message?: string }): void {
    const t = this.terms.get(id);
    if (!t) return;
    if (event.session_id) t.sessionId = event.session_id;
    switch (event.hook_event_name) {
      case 'UserPromptSubmit':
        t.agent = 'working';
        break;
      case 'Notification':
        t.agent = 'needs you';
        this.emit('notice', { term: this.view(id), title: 'Claude needs you', body: event.message ?? '' });
        break;
      case 'Stop':
        t.agent = 'ready';
        this.emit('notice', { term: this.view(id), title: 'Claude is done', body: '', quiet: true });
        break;
      case 'SessionStart':
        t.agent = 'ready';
        break;
    }
    if (t.kind === 'shell') t.kind = 'claude'; // Started by hand with our hooks.
    this.save(t);
    this.emit('list');
  }

  private get(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new Error('That terminal is closed.');
    return t;
  }

  view(id: string): TermView {
    this.get(id);
    return this.list().find((t) => t.id === id)!;
  }

  /** Calls `then` with the screen at one exact moment; output after it follows as 'data'. */
  attach(id: string, then: () => void): Promise<Screen> {
    const { screen, serializer } = this.get(id);
    return new Promise((resolve) => {
      screen.write('', () => {
        then();
        resolve({ cols: screen.cols, rows: screen.rows, state: serializer.serialize({ scrollback: SCROLLBACK }) });
      });
    });
  }

  /** The visible text, newest lines last. */
  text(id: string, lines = 60): string {
    const active = this.get(id).screen.buffer.active;
    const end = active.baseY + active.cursorY;
    const out: string[] = [];
    for (let i = Math.max(0, end - lines + 1); i <= end; i++) out.push(active.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n').trimEnd();
  }

  write(id: string, data: string): void {
    this.get(id).pty?.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const t = this.get(id);
    t.pty?.resize(cols, rows);
    t.screen.resize(cols, rows);
  }

  close(id: string): void {
    const t = this.terms.get(id);
    if (!t) return;
    this.terms.delete(id);
    const { pty } = t;
    t.pty = null;
    pty?.kill();
    t.screen.dispose();
    this.store.removeTerm(id);
    this.emit('list');
  }

  moveAll(fromSpace: string, toSpace: string): void {
    for (const t of this.terms.values()) if (t.spaceId === fromSpace) t.spaceId = toSpace;
    this.emit('list');
  }

  private setCwd(t: Term, cwd: string): void {
    if (t.cwd === cwd) return;
    t.cwd = cwd;
    this.emit('list');
  }

  /** zsh does not announce its folder by itself, so look now and then. */
  async track(): Promise<void> {
    const alive = [...this.terms.values()].filter((t) => t.pty && !t.host);
    if (alive.length === 0) return;
    const pids = alive.map((t) => t.pty!.pid).join(',');
    const out = await new Promise<string>((done) =>
      execFile('/usr/sbin/lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-p', pids], { timeout: 5000 }, (_e, o) => done(String(o))),
    );
    let pid = 0;
    for (const line of out.split('\n')) {
      if (line[0] === 'p') pid = Number(line.slice(1));
      const t = line[0] === 'n' ? alive.find((x) => x.pty?.pid === pid) : undefined;
      if (t) this.setCwd(t, line.slice(1));
    }
  }

  private save(t: Term, screen = ''): void {
    this.store.saveTerm({
      id: t.id,
      spaceId: t.spaceId,
      kind: t.kind,
      cwd: t.cwd,
      host: t.host,
      sessionId: t.sessionId,
      screen,
      cols: t.screen.cols,
      rows: t.screen.rows,
    });
  }

  /** Remembers what every terminal shows, so it can be brought back. */
  saveAll(): void {
    for (const t of this.terms.values()) {
      if (!t.pty) continue;
      const shown = t.kind !== 'claude' ? t.serializer.serialize({ scrollback: 500, excludeModes: true, excludeAltBuffer: true }) : '';
      this.save(t, shown);
    }
  }

  shutdown(): void {
    this.saveAll();
    for (const t of this.terms.values()) {
      const { pty } = t;
      t.pty = null;
      pty?.kill();
      t.screen.dispose();
    }
    this.terms.clear();
  }
}
