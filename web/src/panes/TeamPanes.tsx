import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import type { BeeView, PlanRow, TaskRow } from '../../../server/types.ts';
import { PLAN_WORD, TASK_WORD, thousands, time } from '../format.ts';
import { showBee } from '../layout.ts';
import { attempt, useHive } from '../link.ts';
import { PlanAsk } from '../parts.tsx';

/** Plans and where each task stands. */
export function PlansPane() {
  const all = useHive((s) => s.plans);
  const space = useHive((s) => s.space);
  const tasks = useHive((s) => s.tasks);
  const plans = all.filter((p) => p.spaceId === space).sort((a, b) => b.id - a.id);
  return (
    <div className="pane pad stack">
      {plans.length === 0 && <p className="hint">No plans yet. Add a queen, give her a goal, and her plan appears here for your yes.</p>}
      {plans.map((p) =>
        p.status === 'proposed' ? <PlanAsk key={p.id} plan={p} /> : <Plan key={p.id} plan={p} tasks={tasks.filter((t) => t.planId === p.id)} />,
      )}
    </div>
  );
}

function Plan({ plan, tasks }: { plan: PlanRow; tasks: TaskRow[] }) {
  const bees = useHive((s) => s.bees);
  const nameOf = (id: string) => bees.find((b) => b.id === id)?.name ?? 'removed bee';
  return (
    <section className="plan">
      <header className="row wrap">
        <h2>{plan.goal}</h2>
        <span className={`tag plan-${plan.status}`}>{PLAN_WORD[plan.status]}</span>
        {plan.status === 'running' && (
          <button className="stop push" onClick={() => attempt('plan.stop', { id: plan.id })}>
            Stop plan
          </button>
        )}
      </header>
      <p className="faint">
        {nameOf(plan.queenId)}, {plan.used.orders} of {plan.limits.orders} orders, {plan.used.wakeups} of {plan.limits.wakeups} wake-ups,{' '}
        {thousands(plan.used.tokens)} tokens
      </p>
      <ol className="plan-tasks">
        {tasks.map((t) => (
          <li key={t.id}>
            <details>
              <summary className="row">
                <span className={`tag task-${t.status}`}>{TASK_WORD[t.status]}</span>
                <strong className="cut">{t.title}</strong>
                <span className="faint cut">
                  {nameOf(t.beeId)}
                  {t.deps.length > 0 && `, after ${t.deps.join(' and ')}`}
                  {t.files.length > 0 && `, owns ${t.files.join(', ')}`}
                </span>
                {t.score !== null && <span className="push faint">{Math.round(t.score * 100)}%</span>}
              </summary>
              <pre className="ask-detail">{t.brief}</pre>
              {t.report && <p className="report">{t.report}</p>}
              <div className="row">
                <button onClick={() => showBee(t.beeId)}>Open {nameOf(t.beeId)}</button>
                {t.status === 'running' && (
                  <button className="stop" onClick={() => attempt('task.stop', { planId: t.planId, key: t.key })}>
                    Stop task
                  </button>
                )}
                {(t.status === 'done' || t.status === 'failed') && (
                  <>
                    <button onClick={() => attempt('task.score', { id: t.id, score: 1 })}>Good</button>
                    <button onClick={() => attempt('task.score', { id: t.id, score: 0 })}>Bad</button>
                  </>
                )}
              </div>
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Shared notes. */
export function BoardPane() {
  const all = useHive((s) => s.board);
  const space = useHive((s) => s.space);
  const bees = useHive((s) => s.bees);
  const [topic, setTopic] = useState('');
  const [text, setText] = useState('');
  const rows = all.filter((r) => r.spaceId === space);
  const who = (a: string) => (a === 'you' ? 'you' : a === 'outside' ? 'another session' : (bees.find((b) => b.id === a)?.name ?? 'removed bee'));

  async function post(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    if ((await attempt('board.post', { space, topic: topic || 'note', text })) !== undefined) setText('');
  }

  return (
    <div className="pane pad stack">
      <form className="row wrap" onSubmit={post}>
        <input className="short" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic" aria-label="Topic" maxLength={60} />
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="A fact all bees can read" aria-label="Note" />
        <button className="primary" disabled={!text.trim()}>
          Post
        </button>
      </form>
      {rows.length === 0 && <p className="hint">The board is empty. Bees and you can post facts here; bees read them as information, never as orders.</p>}
      {[...rows].reverse().map((r) => (
        <article key={r.id} className="note">
          <p className="row">
            <strong>{r.topic}</strong>
            <span className="faint">{who(r.author)}</span>
            <time className="faint push">{time(r.ts)}</time>
            <button className="small" onClick={() => attempt('board.remove', { id: r.id })}>
              Remove
            </button>
          </p>
          <p className="prewrap">{r.text}</p>
        </article>
      ))}
    </div>
  );
}

interface Spot {
  x: number;
  y: number;
}

const R = 30;

/** Queens in the middle, workers around them, you at the top. */
function arrange(bees: BeeView[]): Map<string, Spot> {
  const spots = new Map<string, Spot>([['you', { x: 300, y: 42 }]]);
  const queens = bees.filter((b) => b.kind === 'queen');
  const workers = bees.filter((b) => b.kind === 'worker');
  queens.forEach((q, i) => spots.set(q.id, { x: 300 + (i - (queens.length - 1) / 2) * 110, y: queens.length ? 190 : 210 }));
  const from = queens.length ? 0.06 : 0;
  workers.forEach((w, i) => {
    const t = workers.length === 1 ? 0.5 : from + ((1 - 2 * from) * i) / (workers.length - 1);
    const angle = Math.PI * (1 - t);
    spots.set(w.id, { x: 300 + Math.cos(angle) * 225, y: 170 + Math.sin(angle) * 185 });
  });
  return spots;
}

/** The hive as a network: thicker links have helped more. */
export function MapPane() {
  const all = useHive((s) => s.bees);
  const space = useHive((s) => s.space);
  const links = useHive((s) => s.links);
  const orders = useHive((s) => s.orders);
  const flying = useHive((s) => s.flying);
  const [chosen, setChosen] = useState<string | null>(null);
  const bees = useMemo(() => all.filter((b) => b.spaceId === space), [all, space]);
  const key = bees.map((b) => b.id + b.kind).join();
  const spots = useMemo(() => arrange(bees), [key]);
  const fresh = flying.at(-1);
  const pulse = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const a = fresh && spots.get(fresh.from);
    const b = fresh && spots.get(fresh.to);
    if (!a || !b || !pulse.current || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    pulse.current.animate(
      [
        { transform: `translate(${a.x}px, ${a.y}px)`, opacity: 1 },
        { transform: `translate(${b.x}px, ${b.y}px)`, opacity: 1, offset: 0.9 },
        { transform: `translate(${b.x}px, ${b.y}px)`, opacity: 0 },
      ],
      { duration: 900, easing: 'ease-in-out' },
    );
  }, [fresh?.id]);

  const shown = links.filter((l) => spots.has(l.from) && spots.has(l.to));
  const running = new Set(orders.filter((o) => o.status === 'running').map((o) => `${o.source}>${o.beeId}`));
  const active = shown.find((l) => `${l.from}>${l.to}` === chosen);
  const nameOf = (id: string) => (id === 'you' ? 'You' : (bees.find((b) => b.id === id)?.name ?? ''));

  // Lines for work going on now, even where nothing has been learned yet.
  const busyOnly = [...running].filter((k) => !shown.some((l) => `${l.from}>${l.to}` === k)).map((k) => k.split('>') as [string, string]);

  function line(from: string, to: string) {
    const a = spots.get(from)!;
    const b = spots.get(to)!;
    const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Both directions stay visible side by side.
    const ox = (-(b.y - a.y) / d) * 5;
    const oy = ((b.x - a.x) / d) * 5;
    const cut = (R + 3) / d;
    return {
      x1: a.x + (b.x - a.x) * cut + ox,
      y1: a.y + (b.y - a.y) * cut + oy,
      x2: b.x - (b.x - a.x) * cut + ox,
      y2: b.y - (b.y - a.y) * cut + oy,
    };
  }

  if (bees.length === 0) return <div className="pane pad hint">Bees of this space and the links between them appear here.</div>;

  return (
    <div className="pane map">
      <svg viewBox="0 0 600 400" role="group" aria-label="Map of the hive">
        {shown.map((l) => {
          const k = `${l.from}>${l.to}`;
          return (
            <line
              key={k}
              {...line(l.from, l.to)}
              className={`link ${running.has(k) ? 'link-busy' : ''} ${chosen === k ? 'link-chosen' : ''}`}
              strokeWidth={1 + l.weight * 7}
              tabIndex={0}
              role="button"
              aria-label={`Link from ${nameOf(l.from)} to ${nameOf(l.to)}, strength ${l.weight}`}
              onClick={() => setChosen(chosen === k ? null : k)}
              onKeyDown={(e) => e.key === 'Enter' && setChosen(chosen === k ? null : k)}
            />
          );
        })}
        {busyOnly.filter(([a, b]) => spots.has(a) && spots.has(b)).map(([a, b]) => (
          <line key={`${a}>${b}`} {...line(a, b)} className="link link-busy" strokeWidth={3} />
        ))}
        <g transform={`translate(${spots.get('you')!.x} ${spots.get('you')!.y})`}>
          <circle r="24" className="you" />
          <text textAnchor="middle" dominantBaseline="central" className="map-name">
            You
          </text>
        </g>
        {bees.map((b) => {
          const s = spots.get(b.id)!;
          return (
            <g
              key={b.id}
              transform={`translate(${s.x} ${s.y})`}
              className={`cell cell-${b.status} mark-${b.mark} kind-${b.kind} map-bee`}
              role="button"
              tabIndex={0}
              aria-label={`Open ${b.name}`}
              onClick={() => showBee(b.id)}
              onKeyDown={(e) => e.key === 'Enter' && showBee(b.id)}
            >
              <path className="cell-wall" d="M0-30 26-15V15L0 30-26 15V-15z" />
              <circle className="cell-dot" r="14" />
              <text className="cell-letter" textAnchor="middle" dominantBaseline="central">
                {b.name[0]?.toUpperCase()}
              </text>
              <text y="46" textAnchor="middle" className="map-name">
                {b.name}
              </text>
            </g>
          );
        })}
        <circle ref={pulse} r="6" className="pulse" />
      </svg>
      {active ? (
        <div className="map-foot row wrap">
          <span>
            {nameOf(active.from)} to {nameOf(active.to)}
          </span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.05}
            defaultValue={active.weight}
            key={chosen}
            aria-label="Strength"
            onChange={(e) => attempt('link.set', { from: active.from, to: active.to, weight: Number(e.target.value) })}
          />
          <span className="faint">
            {active.weight.toFixed(2)}, used {active.uses} times
          </span>
        </div>
      ) : (
        <p className="map-foot faint">Thicker links have helped more. This teaches the hive whom to trust; it does not train Claude.</p>
      )}
    </div>
  );
}
