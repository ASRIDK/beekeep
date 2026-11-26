import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useRef, useState } from 'react';
import type { TermView } from '../../../server/types.ts';
import { shortPath } from '../format.ts';
import type { PaneParams } from '../layout.ts';
import { show } from '../layout.ts';
import { call, getState, onReconnect, onTerm, useHive } from '../link.ts';

const THEME = {
  background: '#212b33',
  foreground: '#eef0ea',
  cursor: '#f0b64a',
  cursorAccent: '#212b33',
  selectionBackground: '#4a5d6a',
  black: '#1a2229',
  red: '#f0705c',
  green: '#7cc47e',
  yellow: '#f0c33c',
  blue: '#73ade8',
  magenta: '#c79be0',
  cyan: '#6fc6c4',
  white: '#d9dfe0',
  brightBlack: '#7d8f9a',
  brightRed: '#ff8f7d',
  brightGreen: '#9bdc9c',
  brightYellow: '#ffd866',
  brightBlue: '#97c5f5',
  brightMagenta: '#dcb8f0',
  brightCyan: '#93dedc',
  brightWhite: '#ffffff',
};

// Keys Beekeep uses itself, as a normal terminal app would.
const OURS = new Set(['d', 'k', 'f', 'b', 'i', 'p', 't', 'l', 'u', '=', '+', '-', '0', '1', '2', '3', '4', '5', '6', '7', '8', ']', '[']);

const SIZE_KEY = 'hive-term-size';
const savedSize = () => Number(localStorage.getItem(SIZE_KEY)) || 13;
const zoomers = new Set<(size: number) => void>();

/** Larger or smaller text in every terminal. */
export function zoomTerms(by: number): void {
  const size = by === 0 ? 13 : Math.min(28, Math.max(8, savedSize() + by));
  localStorage.setItem(SIZE_KEY, String(size));
  for (const z of zoomers) z(size);
}

/** A real shell. It belongs to the server, so it outlives this pane and window. */
export function TermPane({ params, api }: IDockviewPanelProps<PaneParams>) {
  const box = useRef<HTMLDivElement>(null);
  const search = useRef<SearchAddon | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [finding, setFinding] = useState<string | null>(null);
  const view = useHive((s) => s.terminals.find((x) => x.id === params.termId));
  const home = useHive((s) => s.defaults.home);
  const unread = useHive((s) => s.notices.some((n) => !n.read && n.source === `term:${params.termId}`));

  useEffect(() => {
    if (!view) return;
    const name = view.kind === 'claude' ? 'Claude Code' : 'Terminal';
    api.setTitle(view.host ? `SSH ${view.host}` : `${name} ${shortPath(view.cwd, home)}`);
  }, [view?.cwd, view?.kind, view?.host, home, api]);

  useEffect(() => {
    const see = () => api.isActive && document.hasFocus() && params.termId && void call('notice.read', { source: `term:${params.termId}` }).catch(() => {});
    if (unread) see();
    const off = api.onDidActiveChange(see);
    return () => off.dispose();
  }, [unread, params.termId, api]);

  useEffect(() => {
    const open = () => api.isActive && setFinding((f) => f ?? '');
    window.addEventListener('hive-find', open);
    return () => window.removeEventListener('hive-find', open);
  }, [api]);

  useEffect(() => {
    const term = new Terminal({
      theme: THEME,
      fontFamily: '"SF Mono", Menlo, Monaco, monospace',
      fontSize: savedSize(),
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      macOptionIsMeta: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    const find = new SearchAddon();
    search.current = find;
    term.loadAddon(fit);
    term.loadAddon(find);
    // Links open in a Beekeep browser pane with Command, like in a terminal.
    term.loadAddon(new WebLinksAddon((e, url) => e.metaKey && show('browser', { url })));
    term.open(box.current!);
    // Drawn by the graphics card where possible; the plain way still works without it.
    try {
      const gpu = new WebglAddon();
      gpu.onContextLoss(() => gpu.dispose());
      term.loadAddon(gpu);
    } catch {
      // No WebGL here.
    }
    term.attachCustomKeyEventHandler((e) => !(e.metaKey && OURS.has(e.key.toLowerCase())));

    let id = params.termId;
    let gone = false;
    let off = () => {};
    let attached = false;

    const refit = () => {
      if (!attached || !box.current?.offsetWidth || !box.current.offsetHeight) return;
      fit.fit();
      if (id) call('term.resize', { id, cols: term.cols, rows: term.rows }).catch(() => {});
    };
    const zoom = (size: number) => {
      term.options.fontSize = size;
      refit();
    };
    zoomers.add(zoom);

    async function attach() {
      const screen = await call<{ cols: number; rows: number; state: string }>('term.attach', { id });
      if (gone) return;
      // Draw it at the size it was made for, then fit it to this pane.
      term.reset();
      term.resize(screen.cols, screen.rows);
      await new Promise<void>((done) => term.write(screen.state, done));
    }

    async function begin() {
      try {
        if (id && !getState().terminals.some((t) => t.id === id)) id = undefined;
        if (!id) {
          fit.fit();
          const { space, spaces } = getState();
          const size = { cols: term.cols, rows: term.rows };
          const made = params.command
            ? await call<TermView>('command.run', { space, name: params.command, ...size })
            : await call<TermView>('term.open', {
                space,
                kind: params.termKind,
                host: params.host,
                cwd: params.cwd ?? spaces.find((s) => s.id === space)?.folder,
                run: params.run,
                ...size,
              });
          id = made.id;
          if (gone) return;
          // What was asked for once must not run again when the pane comes back.
          api.updateParameters({ termId: id, run: undefined, command: undefined });
        }
        off();
        off = onTerm(id, (data) => term.write(data));
        attached = false;
        await attach();
        if (gone) return;
        attached = true;
        refit();
        setProblem(null);
      } catch (err) {
        if (!gone) setProblem((err as Error).message);
      }
    }

    term.onData((data) => {
      if (id) call('term.write', { id, data }).catch(() => {});
    });
    const watcher = new ResizeObserver(refit);
    watcher.observe(box.current!);
    const focus = api.onDidActiveChange((e) => e.isActive && term.focus());
    // After a lost connection: same shell if it is still there, else a new one.
    const again = onReconnect(() => void begin());
    void begin().then(() => !gone && api.isActive && term.focus());

    return () => {
      gone = true;
      zoomers.delete(zoom);
      watcher.disconnect();
      focus.dispose();
      again();
      off();
      if (id) call('term.detach', { id }).catch(() => {});
      term.dispose();
    };
    // Opened once per pane; a changed termId is this pane's own doing.
  }, []);

  const step = (back: boolean, text = finding ?? '') =>
    back ? search.current?.findPrevious(text) : search.current?.findNext(text, { incremental: !back });

  return (
    <div className={`term ${unread ? 'ring' : ''}`}>
      {finding !== null && (
        <div className="find row">
          <input
            autoFocus
            value={finding}
            placeholder="Find"
            aria-label="Find in terminal"
            onChange={(e) => {
              setFinding(e.target.value);
              step(false, e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') step(!e.shiftKey);
              if (e.key === 'Escape') {
                search.current?.clearDecorations();
                setFinding(null);
              }
            }}
          />
          <button onClick={() => step(true)}>Previous</button>
          <button onClick={() => step(false)}>Next</button>
          <button onClick={() => setFinding(null)}>Close</button>
        </div>
      )}
      <div className="term-box" ref={box} />
      {problem && <p className="problem pad">{problem}</p>}
      {view && !view.alive && (
        <div className="term-end">
          <span>This shell has ended.</span>
          <button
            onClick={() => {
              if (params.termId) call('term.close', { id: params.termId }).catch(() => {});
              api.close();
            }}
          >
            Close pane
          </button>
        </div>
      )}
    </div>
  );
}
