import '@xterm/xterm/css/xterm.css';
import 'dockview-react/dist/styles/dockview.css';
import './style.css';
import {
  DockviewReact,
  type DockviewTheme,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  closeActive, cycle, focusToward, goTo, type PaneParams, ready, resetLayout, saveNow, show, showBee, split,
} from './layout.ts';
import { attempt, getState, notify, showSpace, start, useHive } from './link.ts';
import { Palette } from './Palette.tsx';
import { BeePane } from './panes/BeePane.tsx';
import { BrowserPane } from './panes/BrowserPane.tsx';
import { ApprovalsPane, BeesPane, NoticesPane, PickPane, RulesPane, UsagePane } from './panes/OtherPanes.tsx';
import { BoardPane, MapPane, PlansPane } from './panes/TeamPanes.tsx';
import { TermPane, zoomTerms } from './panes/TermPane.tsx';
import { Cell, Icon, ICON } from './parts.tsx';
import { Sidebar } from './Sidebar.tsx';

const panes = {
  bees: BeesPane, bee: BeePane, term: TermPane, approvals: ApprovalsPane, pick: PickPane, plans: PlansPane,
  board: BoardPane, map: MapPane, notices: NoticesPane, usage: UsagePane, rules: RulesPane, browser: BrowserPane,
};

const theme: DockviewTheme = { name: 'hive', className: 'dockview-theme-hive', colorScheme: 'dark' };

function useNeeds(): number {
  const approvals = useHive((s) => s.approvals.length);
  const plans = useHive((s) => s.plans);
  return approvals + plans.filter((p) => p.status === 'proposed').length;
}

function Tab({ api, params }: IDockviewPanelHeaderProps<PaneParams>) {
  const [title, setTitle] = useState(api.title);
  const bee = useHive((s) => s.bees.find((b) => b.id === params.beeId));
  const term = useHive((s) => s.terminals.find((t) => t.id === params.termId));
  const source = bee ? `bee:${bee.id}` : params.termId ? `term:${params.termId}` : null;
  const unread = useHive((s) => source !== null && s.notices.some((n) => !n.read && n.source === source));
  const fresh = useHive((s) => (api.id === 'notices' ? s.notices.filter((n) => !n.read).length : 0));
  const needs = useNeeds();
  const count = api.id === 'approvals' ? needs : fresh;
  useEffect(() => {
    const off = api.onDidTitleChange((e) => setTitle(e.title));
    return () => off.dispose();
  }, [api]);
  return (
    <div className={`tab ${unread ? 'tab-unread' : ''}`}>
      {bee && <Cell bee={bee} size={18} />}
      {term?.agent && term.agent !== 'ready' && <i className={`dot agent-${term.agent.replace(' ', '-')}`} title={term.agent} />}
      <span>{title}</span>
      {count > 0 && <span className="count">{count}</span>}
      <button className="icon" aria-label={`Close ${title}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => api.close()}>
        <Icon d={ICON.close} />
      </button>
    </div>
  );
}

function GroupButtons({ api, activePanel }: IDockviewHeaderActionsProps) {
  return (
    <div className="group-buttons">
      <button className="icon" title="Split right (Command D)" aria-label="Split right" onClick={() => split('right', activePanel?.id)}>
        <Icon d={ICON.right} />
      </button>
      <button className="icon" title="Split down (Command Shift D)" aria-label="Split down" onClick={() => split('below', activePanel?.id)}>
        <Icon d={ICON.down} />
      </button>
      <button
        className="icon"
        title="Fill window"
        aria-label="Fill window"
        onClick={() => (api.isMaximized() ? api.exitMaximized() : api.maximize())}
      >
        <Icon d={ICON.full} />
      </button>
    </div>
  );
}

interface TopProps {
  onTask: () => void;
  onPalette: () => void;
  onSide: () => void;
}

function TopBar({ onTask, onPalette, onSide }: TopProps) {
  const bees = useHive((s) => s.bees);
  const orders = useHive((s) => s.orders);
  const guard = useHive((s) => s.guard);
  const unread = useHive((s) => s.notices.filter((n) => !n.read).length);
  const needs = useNeeds();
  const working = bees.filter((b) => b.currentOrderId !== null).length;
  const queued = orders.filter((o) => o.status === 'queued').length;

  return (
    <header className="top">
      <button className="icon" aria-label="Show or hide spaces" title="Spaces (Command B)" onClick={onSide}>
        <Icon d={ICON.side} />
      </button>
      <h1>Beekeep</h1>
      <p className="faint">
        {bees.length === 0 ? 'No bees yet' : `${bees.length} ${bees.length === 1 ? 'bee' : 'bees'}, ${working} working`}
        {queued > 0 && `, ${queued} ${queued === 1 ? 'order' : 'orders'} waiting`}
      </p>
      {queued > 0 && working === 0 && !guard.blocked && <button onClick={() => attempt('queue.resume')}>Start waiting orders</button>}
      {needs > 0 && (
        <button className="call" onClick={() => show('approvals')}>
          {needs === 1 ? '1 thing needs you' : `${needs} things need you`}
        </button>
      )}
      <div className="row push">
        {working > 0 && (
          <button className="stop" onClick={() => attempt('stopAll')}>
            Stop all
          </button>
        )}
        <button onClick={() => show('notices')} title="Notices (Command I)">
          {unread > 0 ? `${unread} new` : 'Notices'}
        </button>
        <button onClick={onTask} disabled={bees.length === 0} title="Command K">
          Task a bee
        </button>
        <button onClick={onPalette} title="Command Shift P">
          Commands
        </button>
      </div>
    </header>
  );
}

function TaskDialog({ beeId: wanted, open, onClose }: { beeId?: string; open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const all = useHive((s) => s.bees);
  const space = useHive((s) => s.space);
  const [beeId, setBeeId] = useState('');
  const [text, setText] = useState('');
  // Queens first: a goal usually goes to one.
  const bees = [...all].sort(
    (a, b) => Number(b.spaceId === space) - Number(a.spaceId === space) || Number(b.kind === 'queen') - Number(a.kind === 'queen'),
  );
  const chosen = bees.find((b) => b.id === beeId) ?? bees[0];

  useEffect(() => {
    const d = ref.current!;
    if (open && wanted) setBeeId(wanted);
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open, wanted]);

  async function send(e?: FormEvent, now = false) {
    e?.preventDefault();
    if (!chosen || !text.trim()) return;
    if ((await attempt('order.send', { beeId: chosen.id, text, now })) === undefined) return;
    setText('');
    onClose();
    showBee(chosen.id);
  }

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-label="Task a bee">
      <form className="form" onSubmit={send}>
        <label>
          Bee
          <select value={chosen?.id ?? ''} onChange={(e) => setBeeId(e.target.value)}>
            {bees.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.kind === 'queen' ? ' (queen)' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Order
          <textarea
            rows={4}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(undefined, e.metaKey);
              }
            }}
          />
        </label>
        <div className="row">
          <button className="primary" type="submit" disabled={!text.trim()}>
            {chosen?.currentOrderId != null ? 'Queue order' : 'Send order'}
          </button>
          {chosen?.currentOrderId != null && (
            <button type="button" disabled={!text.trim()} onClick={() => send(undefined, true)}>
              Stop and do now
            </button>
          )}
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  );
}

function Hold() {
  const guard = useHive((s) => s.guard);
  if (!guard.blocked) return null;
  return (
    <p className="banner row wrap" role="status">
      <span>{guard.blocked} No new work starts.</span>
      {guard.paused ? (
        <button onClick={() => attempt('guard.set', { paused: false })}>Let bees work</button>
      ) : (
        <button onClick={() => attempt('guard.override')}>Continue for one hour</button>
      )}
    </p>
  );
}

function App() {
  const phase = useHive((s) => s.phase);
  const notice = useHive((s) => s.notice);
  const space = useHive((s) => s.space);
  const [seen, setSeen] = useState(false);
  const [tasking, setTasking] = useState<{ beeId?: string } | null>(null);
  const [palette, setPalette] = useState(false);
  const [side, setSide] = useState(() => localStorage.getItem('hive-side') !== 'off');
  const needs = useNeeds();
  const unread = useHive((s) => s.notices.filter((n) => !n.read).length);

  // Keep panes on screen through a short disconnection.
  useEffect(() => {
    if (phase === 'live') setSeen(true);
  }, [phase]);

  useEffect(() => {
    document.title = needs > 0 ? `(${needs}) Beekeep` : 'Beekeep';
    // The Mac app shows this number on its Dock icon.
    (window as { webkit?: { messageHandlers?: { badge?: { postMessage: (n: number) => void } } } }).webkit?.messageHandlers?.badge?.postMessage(needs + unread);
  }, [needs, unread]);

  const flipSide = () =>
    setSide((v) => {
      localStorage.setItem('hive-side', v ? 'off' : 'on');
      return !v;
    });

  useEffect(() => {
    const arrows = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' } as const;
    const keys = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      const act = (f: () => void) => {
        e.preventDefault();
        f();
      };
      if (e.altKey) {
        const way = arrows[e.key as keyof typeof arrows];
        if (way) act(() => focusToward(way));
        return;
      }
      if (e.shiftKey) {
        if (k === 'd') act(() => split('below'));
        else if (k === 'p') act(() => setPalette(true));
        else if (k === 'l') act(() => show('browser', { url: 'about:blank' }));
        else if (k === ']' || k === '}') act(() => cycle(1));
        else if (k === '[' || k === '{') act(() => cycle(-1));
        else if (k === 'u') {
          act(() => {
            const n = getState().notices.find((x) => !x.read);
            if (!n) return notify('Nothing new.');
            void attempt('notice.read', { id: n.id });
            goTo(n.spaceId, n.source);
          });
        } else if (k === '+') act(() => zoomTerms(1));
        return;
      }
      if (k === 'd') act(() => split('right'));
      else if (k === 'k') act(() => setTasking({}));
      else if (k === 'p') act(() => setPalette(true));
      else if (k === 'b') act(flipSide);
      else if (k === 'i') act(() => show('notices'));
      else if (k === 't') act(() => show('term'));
      else if (k === 'w') act(closeActive);
      else if (k === 'f') act(() => window.dispatchEvent(new Event('hive-find')));
      else if (k === '=' || k === '+') act(() => zoomTerms(1));
      else if (k === '-') act(() => zoomTerms(-1));
      else if (k === '0') act(() => zoomTerms(0));
      else if (/^[1-9]$/.test(k)) {
        const s = getState().spaces[Number(k) - 1];
        if (s) {
          act(() => {
            saveNow();
            showSpace(s.id);
          });
        }
      }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, []);

  if (phase === 'locked') {
    return (
      <main className="gate">
        <h1>Beekeep</h1>
        <p>
          This window is not signed in to the running hive. Open a terminal and run <code>beekeep</code>.
        </p>
      </main>
    );
  }
  if (!seen) {
    return (
      <main className="gate">
        <h1>Beekeep</h1>
        <p>{phase === 'lost' || phase === 'stopped' ? 'Beekeep is not running. Open a terminal and run hive.' : 'Opening the hive.'}</p>
      </main>
    );
  }

  return (
    <div className="app">
      <TopBar onTask={() => setTasking({})} onPalette={() => setPalette(true)} onSide={flipSide} />
      <Hold />
      {phase === 'stopped' && (
        <p className="banner" role="status">
          Beekeep was stopped. Close this window, or run <code>beekeep</code> in a terminal to start it again.
        </p>
      )}
      {phase === 'lost' && (
        <p className="banner" role="status">
          Connection lost. Trying again. If Beekeep was stopped, run <code>beekeep</code> in a terminal.
        </p>
      )}
      <div className="main">
        {side && <Sidebar />}
        <div className="dock" key={space}>
          <DockviewReact
            components={panes}
            defaultTabComponent={Tab}
            rightHeaderActionsComponent={GroupButtons}
            theme={theme}
            onReady={(e) => ready(e.api, space)}
          />
        </div>
      </div>
      <TaskDialog beeId={tasking?.beeId} open={tasking !== null} onClose={() => setTasking(null)} />
      <Palette open={palette} onClose={() => setPalette(false)} onTask={(beeId) => setTasking({ beeId })} />
      {notice && (
        <p className={`notice${notice.problem ? ' is-problem' : ''}`} role={notice.problem ? 'alert' : 'status'}>
          {notice.text}
          <button className="icon" aria-label="Dismiss" onClick={() => notify(null)}>
            <Icon d={ICON.close} />
          </button>
        </p>
      )}
    </div>
  );
}

// For the Mac app's menu.
(window as unknown as { hive: object }).hive = { show, split, resetLayout };

void start();
createRoot(document.getElementById('root')!).render(<App />);
