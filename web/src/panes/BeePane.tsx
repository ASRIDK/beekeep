import type { IDockviewPanelProps } from 'dockview-react';
import { type KeyboardEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BeeView, EventRow } from '../../../server/types.ts';
import { BeeForm } from '../BeeForm.tsx';
import {
  dayLabel, MODE_WORD, modelWord, seconds, shortPath, sourceWord, thousands, time, toolDetail, toolSummary, toolWord, turnProblem,
} from '../format.ts';
import { attempt, call, loadEvents, loadOlder, useHive } from '../link.ts';
import { Ask, Cell, Icon, ICON, Status } from '../parts.tsx';

const NONE: EventRow[] = [];

export function BeePane({ params, api }: IDockviewPanelProps<{ beeId: string }>) {
  const { beeId } = params;
  const bee = useHive((s) => s.bees.find((b) => b.id === beeId));
  const live = useHive((s) => s.phase === 'live');

  useEffect(() => {
    if (live) void loadEvents(beeId);
  }, [beeId, live]);

  useEffect(() => {
    if (bee) api.setTitle(bee.name);
  }, [bee?.name, api]);

  // Looking at a bee counts as having seen what it wanted.
  const unread = useHive((s) => s.notices.some((n) => !n.read && n.source === `bee:${beeId}`));
  useEffect(() => {
    const see = () => api.isActive && document.hasFocus() && void call('notice.read', { source: `bee:${beeId}` }).catch(() => {});
    if (unread) see();
    const off = api.onDidActiveChange(see);
    return () => off.dispose();
  }, [unread, beeId, api]);

  if (!bee) {
    return (
      <div className="empty">
        <p>This bee was removed.</p>
        <button onClick={() => api.close()}>Close pane</button>
      </div>
    );
  }
  return <Bee bee={bee} />;
}

function Bee({ bee }: { bee: BeeView }) {
  const events = useHive((s) => s.events[bee.id]) ?? NONE;
  const [editing, setEditing] = useState(false);
  const [share, setShare] = useState(0.45);
  const body = useRef<HTMLDivElement>(null);
  const home = useHive((s) => s.defaults.home);
  const working = bee.currentOrderId !== null;

  function drag(e: React.PointerEvent) {
    e.preventDefault();
    const box = body.current!.getBoundingClientRect();
    const move = (m: PointerEvent) => setShare(Math.min(0.85, Math.max(0.12, (m.clientY - box.top) / box.height)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <div className="bee">
      <header className="bee-head">
        <Cell bee={bee} size={34} />
        <div className="bee-id">
          <div className="row">
            <h2>{bee.name}</h2>
            <Status bee={bee} />
          </div>
          <p className="faint" title={bee.workspace}>
            {bee.kind === 'queen' && 'Queen, '}
            {modelWord(bee)}, {MODE_WORD[bee.mode]} in {shortPath(bee.workspace, home)}
            {bee.mode !== 'look' && bee.abilities.shell && !bee.confined && ', shell not confined'}
          </p>
        </div>
        <Memory bee={bee} last={events.at(-1)?.id} />
        <div className="row">
          <button disabled={working} title={working ? 'Stop the bee first' : undefined} onClick={() => setEditing(!editing)}>
            {editing ? 'Close' : 'Edit'}
          </button>
          <button className="stop" disabled={!working || bee.status === 'stopping'} onClick={() => attempt('bee.stop', { id: bee.id })}>
            Stop
          </button>
        </div>
      </header>

      {editing && (
        <div className="edit">
          <BeeForm bee={bee} onDone={() => setEditing(false)} />
        </div>
      )}

      <div className="bee-body" ref={body}>
        <div className="bee-actions" style={{ flexGrow: share }}>
          <Actions bee={bee} events={events} />
        </div>
        <div
          className="divider"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize actions and chat"
          aria-valuenow={Math.round(share * 100)}
          tabIndex={0}
          onPointerDown={drag}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') setShare((v) => Math.max(0.12, v - 0.05));
            if (e.key === 'ArrowDown') setShare((v) => Math.min(0.85, v + 0.05));
          }}
        />
        <div className="bee-chat" style={{ flexGrow: 1 - share }}>
          <Chat bee={bee} events={events} />
        </div>
      </div>

      <Waiting bee={bee} />
      <Composer bee={bee} />
    </div>
  );
}

/** How full the bee's memory is, with a way to shorten it. */
function Memory({ bee, last }: { bee: BeeView; last: number | undefined }) {
  const [use, setUse] = useState<{ used: number; max: number; parts: { name: string; tokens: number }[] } | null>(null);
  const awake = bee.status === 'idle';
  useEffect(() => {
    if (!awake) return;
    let gone = false;
    call<typeof use>('bee.context', { id: bee.id })
      .then((u) => !gone && setUse(u))
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [awake, bee.id, last]);
  if (!use || !use.max) return null;
  const pct = Math.round((use.used / use.max) * 100);
  return (
    <details className="memory">
      <summary title="How full its memory is">
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, pct)}%` }} />
        </span>
        {pct}%
      </summary>
      <div className="pop">
        {use.parts.map((p) => (
          <p key={p.name} className="row">
            <span>{p.name}</span>
            <span className="push faint">{thousands(p.tokens)}</span>
          </p>
        ))}
        <button onClick={() => attempt('order.send', { beeId: bee.id, text: '/compact' })}>Shorten memory</button>
      </div>
    </details>
  );
}

/** Keeps a list at its newest line unless the person has scrolled up to read. */
function useFollow(key: unknown) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const height = useRef(0);
  const toEnd = () => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  };
  useLayoutEffect(toEnd, [key]);
  useEffect(() => {
    // Panes change size all the time; that must not count as scrolling away.
    const watch = new ResizeObserver(() => {
      height.current = box.current?.clientHeight ?? 0;
      toEnd();
    });
    watch.observe(box.current!);
    return () => watch.disconnect();
  }, []);
  const onScroll = () => {
    const el = box.current!;
    if (el.clientHeight !== height.current) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref: box, onScroll };
}

function Older({ beeId }: { beeId: string }) {
  const more = useHive((s) => s.older[beeId]);
  return more ? (
    <button className="older" onClick={() => loadOlder(beeId)}>
      Show earlier
    </button>
  ) : null;
}

// Actions: everything the bee did, in order.

type Outcome = 'running' | 'waiting for you' | 'done' | 'failed' | 'refused' | 'cut off';

function Actions({ bee, events }: { bee: BeeView; events: EventRow[] }) {
  const follow = useFollow(events.at(-1)?.id);
  const asks = useHive((s) => s.approvals);
  const results = useMemo(() => {
    const map = new Map<unknown, EventRow>();
    for (const e of events) if (e.kind === 'result') map.set(e.data.toolUseId, e);
    return map;
  }, [events]);

  const shown = events.filter((e) => e.kind !== 'result' && e.kind !== 'say' && e.kind !== 'session');
  const orderStart = events.findLast((e) => e.kind === 'order')?.id ?? 0;
  let lastDay = '';

  function outcome(e: EventRow): Outcome {
    const result = results.get(e.data.toolUseId);
    if (result) return result.data.ok ? 'done' : /^The keeper refused/.test(String(result.data.text)) ? 'refused' : 'failed';
    if (bee.currentOrderId === null || e.id < orderStart) return 'cut off';
    const input = JSON.stringify(e.data.input);
    const asking = asks.some((a) => a.beeId === bee.id && a.tool === e.data.tool && JSON.stringify(a.input).startsWith(input.slice(0, -1)));
    return asking ? 'waiting for you' : 'running';
  }

  return (
    <div className="list mono" {...follow} aria-label={`Actions of ${bee.name}`}>
      <Older beeId={bee.id} />
      {shown.length === 0 && <p className="hint">Every action {bee.name} takes will be listed here.</p>}
      {shown.map((e) => {
        const label = dayLabel(e.ts);
        const head = label !== lastDay ? <p className="day">{label}</p> : null;
        lastDay = label;
        return (
          <div key={e.id}>
            {head}
            <ActionLine
              bee={bee}
              e={e}
              result={e.kind === 'action' ? results.get(e.data.toolUseId) : undefined}
              outcome={e.kind === 'action' ? outcome(e) : 'done'}
            />
          </div>
        );
      })}
    </div>
  );
}

interface LineProps {
  bee: BeeView;
  e: EventRow;
  result: EventRow | undefined;
  outcome: Outcome;
}

function ActionLine({ bee, e, result, outcome }: LineProps) {
  const at = <time>{time(e.ts)}</time>;
  const d = e.data;
  const bees = useHive((s) => s.bees);
  switch (e.kind) {
    case 'order':
      return (
        <p className="line line-order">
          {at}
          <b>{sourceWord(String(d.source), bees)}</b>
          <span className="cut">{String(d.text)}</span>
          {bee.mode !== 'look' && bee.currentOrderId === null && typeof d.uuid === 'string' && (
            <button className="small" title="Put files back as they were before this order" onClick={() => attempt('bee.undo', { id: bee.id, uuid: d.uuid })}>
              Undo files
            </button>
          )}
        </p>
      );
    case 'action': {
      const tool = String(d.tool);
      const input = d.input as Record<string, unknown>;
      return (
        <details className={`line-box action-${outcome.replaceAll(' ', '-')}`}>
          <summary className="line">
            {at}
            <b>
              {d.helper ? 'Helper: ' : ''}
              {toolWord(tool)}
            </b>
            <span className="cut">{toolSummary(tool, input, bee.workspace)}</span>
            <i className="outcome">{outcome}</i>
          </summary>
          <pre>{toolDetail(tool, input)}</pre>
          {result && (
            <pre className="result">
              {String(result.data.text) || '(no output)'}
              {result.data.clipped ? '\n… cut here, output was longer' : ''}
            </pre>
          )}
        </details>
      );
    }
    case 'think':
    case 'message':
      return (
        <details className="line-box">
          <summary className="line">
            {at}
            <b>{e.kind === 'think' ? 'Thought' : 'Got messages'}</b>
            <span className="cut">{String(d.text)}</span>
          </summary>
          <pre>{String(d.text)}</pre>
        </details>
      );
    case 'approval':
      return (
        <p className="line line-ask">
          {at}
          <b>Asked you</b>
          <span className="cut">{String(d.reason)}</span>
        </p>
      );
    case 'decision':
      return (
        <p className={`line decision-${String(d.decision)}`}>
          {at}
          <b>{d.decision === 'allowed' ? (d.answers ? 'You answered' : 'You allowed it') : d.decision === 'denied' ? 'Refused' : 'Request expired'}</b>
          {d.answers != null && <span className="cut">{Object.values(d.answers as object).join('; ')}</span>}
        </p>
      );
    case 'turn':
      return (
        <p className={`line line-turn ${d.ok || d.stopped ? '' : 'line-bad'}`}>
          {at}
          <b>{d.ok ? 'Finished' : d.stopped ? 'Stopped by you' : 'Ended early'}</b>
          <span>
            {seconds(Number(d.ms))}, {thousands(Number(d.tokensIn))} tokens read, {thousands(Number(d.tokensOut))} written
          </span>
        </p>
      );
    case 'limit': {
      if (d.status === 'allowed') return null;
      return (
        <p className="line line-bad">
          {at}
          <b>Usage limit</b>
          <span>{d.status === 'rejected' ? 'Reached. The plan refused this step.' : 'Getting close.'}</span>
        </p>
      );
    }
    case 'error':
    case 'note':
      return (
        <p className={e.kind === 'error' ? 'line line-bad' : 'line'}>
          {at}
          <b>{e.kind === 'error' ? 'Problem' : 'Note'}</b>
          <span>{String(d.text)}</span>
        </p>
      );
    default:
      return (
        <p className="line line-other">
          {at}
          <b>Other</b>
          <span>{[d.type, d.subtype].filter(Boolean).join(' ')}</span>
        </p>
      );
  }
}

// Chat: what was said.

function Chat({ bee, events }: { bee: BeeView; events: EventRow[] }) {
  const typing = useHive((s) => s.typing[bee.id]);
  const bees = useHive((s) => s.bees);
  const follow = useFollow(`${events.at(-1)?.id}:${typing?.length ?? 0}`);
  const shown = events.filter(
    (e) => e.kind === 'order' || (e.kind === 'say' && !e.data.helper) || e.kind === 'error' || e.kind === 'note' || turnProblem(e) !== null,
  );
  const lastOrder = events.findLast((e) => e.kind === 'order');
  const ended = lastOrder && bee.currentOrderId === null && events.some((e) => e.kind === 'turn' && e.id > lastOrder.id);

  return (
    <div className="list chat" {...follow} aria-label={`Chat with ${bee.name}`} aria-live="polite">
      <Older beeId={bee.id} />
      {shown.length === 0 && !typing && <p className="hint">Give {bee.name} an order below to start.</p>}
      {shown.map((e) => (
        <article key={e.id} className={`say say-${e.data.stopped ? 'note' : e.kind} ${e.kind === 'order' && e.data.source !== 'you' ? 'say-other' : ''}`}>
          <span className="who">
            {e.kind === 'order'
              ? e.data.source === 'you'
                ? 'you'
                : (bees.find((b) => b.id === e.data.source)?.name ?? String(e.data.source))
              : e.kind === 'say'
                ? bee.name
                : 'hive'}
          </span>
          <p>{e.kind === 'turn' ? turnProblem(e) : String(e.data.text)}</p>
        </article>
      ))}
      {typing && (
        <article className="say say-say">
          <span className="who">{bee.name}</span>
          <p>
            {typing}
            <span className="caret" />
          </p>
        </article>
      )}
      {ended && <Feedback key={lastOrder.id} orderId={Number(lastOrder.data.orderId)} />}
    </div>
  );
}

/** Thumbs up or down. Beekeep learns from it whom to trust. */
function Feedback({ orderId }: { orderId: number }) {
  const [given, setGiven] = useState<boolean | null>(null);
  const give = async (good: boolean) => {
    if ((await attempt('order.feedback', { id: orderId, good })) !== undefined) setGiven(good);
  };
  return (
    <div className="feedback row">
      {given === null ? (
        <>
          <button className="icon" aria-label="Good result" title="Good result" onClick={() => give(true)}>
            <Icon d={ICON.thumb} />
          </button>
          <button className="icon flip" aria-label="Bad result" title="Bad result" onClick={() => give(false)}>
            <Icon d={ICON.thumb} />
          </button>
        </>
      ) : (
        <span className="faint">{given ? 'Noted as good.' : 'Noted as bad.'}</span>
      )}
    </div>
  );
}

function Waiting({ bee }: { bee: BeeView }) {
  const approvals = useHive((s) => s.approvals);
  const orders = useHive((s) => s.orders);
  const bees = useHive((s) => s.bees);
  const asks = approvals.filter((a) => a.beeId === bee.id);
  const queued = orders.filter((o) => o.beeId === bee.id && o.status === 'queued');
  if (asks.length === 0 && queued.length === 0) return null;
  return (
    <div className="waiting">
      {asks.map((a) => (
        <Ask key={a.id} ask={a} bee={bee} />
      ))}
      {queued.map((o) => (
        <div key={o.id} className="queued">
          <span className="faint">{o.source === 'you' ? 'Next' : `Next, ${sourceWord(o.source, bees).toLowerCase()}`}</span>
          <span className="cut">{o.text}</span>
          <button onClick={() => attempt('order.cancel', { id: o.id })}>Cancel</button>
        </div>
      ))}
    </div>
  );
}

function Composer({ bee }: { bee: BeeView }) {
  const [text, setText] = useState('');
  const [planFirst, setPlanFirst] = useState(false);
  const working = bee.currentOrderId !== null;

  async function send(now: boolean) {
    const body = text.trim();
    if (!body) return;
    if ((await attempt('order.send', { beeId: bee.id, text: body, now, planFirst })) !== undefined) {
      setText('');
      setPlanFirst(false);
    }
  }

  function keys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    void send(e.metaKey);
  }

  return (
    <div className="composer">
      <textarea
        aria-label={`Order for ${bee.name}`}
        placeholder={`Order for ${bee.name}`}
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={keys}
      />
      {bee.mode !== 'look' && bee.kind === 'worker' && (
        <label className="choice" title="It shows you a plan and waits for your yes before changing anything">
          <input type="checkbox" checked={planFirst} onChange={(e) => setPlanFirst(e.target.checked)} />
          <span>Plan first</span>
        </label>
      )}
      {working ? (
        <>
          <button onClick={() => send(false)} disabled={!text.trim()} title="Enter">
            Queue after this
          </button>
          <button className="primary" onClick={() => send(true)} disabled={!text.trim()} title="Command Enter">
            Stop and do now
          </button>
        </>
      ) : (
        <button className="primary" onClick={() => send(false)} disabled={!text.trim()} title="Enter">
          Send order
        </button>
      )}
    </div>
  );
}
