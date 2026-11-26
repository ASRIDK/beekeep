import type { IDockviewPanelProps } from 'dockview-react';
import { useEffect, useRef, useState } from 'react';
import type { Command, NoticeRow } from '../../../server/types.ts';
import { BeeForm } from '../BeeForm.tsx';
import { dayLabel, shortPath, thousands, time } from '../format.ts';
import { goTo, onScreen, openIn, type PaneKind, showBee, TITLES } from '../layout.ts';
import { attempt, call, useHive } from '../link.ts';
import { Ask, Cell, PlanAsk, Status } from '../parts.tsx';

/** Every bee of this space at a glance. */
export function BeesPane() {
  const all = useHive((s) => s.bees);
  const space = useHive((s) => s.space);
  const orders = useHive((s) => s.orders);
  const [adding, setAdding] = useState(false);
  const bees = all.filter((b) => b.spaceId === space).sort((a, b) => Number(b.kind === 'queen') - Number(a.kind === 'queen'));

  return (
    <div className="pane">
      {bees.length === 0 && !adding && (
        <div className="empty">
          <p>No bees in this space yet. Add one, then give it an order. A queen can lead the others.</p>
        </div>
      )}
      <ul className="roster">
        {bees.map((b) => {
          const now = orders.find((o) => o.id === b.currentOrderId);
          const queued = orders.filter((o) => o.beeId === b.id && o.status === 'queued').length;
          return (
            <li key={b.id}>
              <button className="roster-row" onClick={() => showBee(b.id)}>
                <Cell bee={b} size={36} />
                <span className="roster-text">
                  <span className="row">
                    <strong>{b.name}</strong>
                    <Status bee={b} />
                    {queued > 0 && <span className="faint">{queued} waiting</span>}
                  </span>
                  <span className="faint cut">{now?.text ?? b.detail ?? (b.role || (b.kind === 'queen' ? 'Plans and leads' : ''))}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {adding ? (
        <BeeForm
          onDone={(made) => {
            setAdding(false);
            if (made) showBee(made.id);
          }}
        />
      ) : (
        <div className="pad">
          <button className={bees.length === 0 ? 'primary' : ''} onClick={() => setAdding(true)}>
            Add bee
          </button>
        </div>
      )}
    </div>
  );
}

/** Everything waiting for the person, from any bee in any space. */
export function ApprovalsPane() {
  const approvals = useHive((s) => s.approvals);
  const plans = useHive((s) => s.plans);
  const bees = useHive((s) => s.bees);
  const proposed = plans.filter((p) => p.status === 'proposed');
  return (
    <div className="pane pad">
      {approvals.length === 0 && proposed.length === 0 && (
        <p className="hint">Nothing needs you. Plans, questions, shell commands, web pages and files outside a bee’s folder appear here.</p>
      )}
      {proposed.map((p) => (
        <PlanAsk key={p.id} plan={p} />
      ))}
      {approvals.map((a) => (
        <Ask key={a.id} ask={a} bee={bees.find((b) => b.id === a.beeId)} />
      ))}
    </div>
  );
}

const CHOICES: PaneKind[] = ['bees', 'approvals', 'plans', 'map', 'board', 'notices', 'usage', 'rules'];

/** A fresh split: choose what goes in it. */
export function PickPane({ api }: IDockviewPanelProps) {
  const allBees = useHive((s) => s.bees);
  const space = useHive((s) => s.space);
  const allTerms = useHive((s) => s.terminals);
  const home = useHive((s) => s.defaults.home);
  const first = useRef<HTMLButtonElement>(null);
  const bees = allBees.filter((b) => b.spaceId === space);
  const terminals = allTerms.filter((t) => t.spaceId === space && !onScreen('termId', t.id));

  // The dock moves focus to the pane itself, so claim it after that.
  useEffect(() => {
    const claim = () => requestAnimationFrame(() => first.current?.focus());
    if (api.isActive) claim();
    const off = api.onDidActiveChange((e) => e.isActive && claim());
    return () => off.dispose();
  }, [api]);

  return (
    <div className="pane pad pick">
      <h2>What goes in this pane?</h2>
      <div className="pick-group">
        <button className="pick-row" ref={first} onClick={() => openIn(api.id, 'term')}>
          New terminal
        </button>
        <button className="pick-row" onClick={() => openIn(api.id, 'term', { termKind: 'claude' })}>
          Claude Code <span className="faint">full, with your own setup</span>
        </button>
        <button className="pick-row" onClick={() => openIn(api.id, 'browser', { url: 'about:blank' })}>
          Browser
        </button>
      </div>
      <SshForm pickId={api.id} />
      <div className="pick-tiles">
        {CHOICES.map((k) => (
          <button key={k} onClick={() => openIn(api.id, k)}>
            {TITLES[k]}
          </button>
        ))}
      </div>
      {bees.length > 0 && (
        <>
          <h3>Bees</h3>
          <div className="pick-group">
            {bees.map((b) => (
              <button key={b.id} className="pick-row" onClick={() => openIn(api.id, 'bee', { beeId: b.id })}>
                <Cell bee={b} size={24} /> {b.name}
              </button>
            ))}
          </div>
        </>
      )}
      <Commands pickId={api.id} />
      {terminals.length > 0 && (
        <>
          <h3>Terminals without a pane</h3>
          <div className="pick-group">
            {terminals.map((t) => (
              <div key={t.id} className="pick-split">
                <button className="pick-row" onClick={() => openIn(api.id, 'term', { termId: t.id })}>
                  {shortPath(t.cwd, home)}
                  <span className="faint">{t.agent ?? (t.alive ? 'running' : 'ended')}</span>
                </button>
                <button onClick={() => attempt('term.close', { id: t.id })}>End</button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SshForm({ pickId }: { pickId: string }) {
  const [host, setHost] = useState('');
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault();
        if (host.trim()) openIn(pickId, 'term', { termKind: 'ssh', host: host.trim() });
      }}
    >
      <input className="grow" value={host} onChange={(e) => setHost(e.target.value)} placeholder="user@host for SSH" aria-label="SSH address" spellCheck={false} />
      <button disabled={!host.trim()}>Connect</button>
    </form>
  );
}

/** What this space's hive.json offers. */
function Commands({ pickId }: { pickId: string }) {
  const space = useHive((s) => s.space);
  const [list, setList] = useState<Command[]>([]);
  const load = () => call<Command[]>('command.list', { space }).then(setList, () => {});
  useEffect(() => void load(), [space]);
  if (list.length === 0) return null;
  const trusted = list[0]!.trusted;
  return (
    <>
      <h3>Project commands</h3>
      {!trusted && (
        <div className="ask">
          <p>
            <code>{list[0]!.file}</code> offers these commands. They run in your terminal with your rights.
          </p>
          <pre className="ask-detail">{list.map((c) => `${c.name}: ${c.run}`).join('\n')}</pre>
          <button className="primary" onClick={() => void attempt('command.trust', { space }).then(load)}>
            Allow these commands
          </button>
        </div>
      )}
      {trusted && (
        <div className="pick-group">
          {list.map((c) => (
            <button key={c.name} className="pick-row" title={c.run} onClick={() => openIn(pickId, 'term', { command: c.name })}>
              {c.name} <span className="faint cut">{c.run}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Everything that wanted attention, newest first. */
export function NoticesPane() {
  const notices = useHive((s) => s.notices);
  const spaces = useHive((s) => s.spaces);
  const unread = notices.filter((n) => !n.read).length;

  function go(n: NoticeRow) {
    void attempt('notice.read', { id: n.id });
    goTo(n.spaceId, n.source);
  }

  return (
    <div className="pane">
      <div className="pad row">
        <span className="faint">{unread === 0 ? 'Nothing new' : `${unread} new`}</span>
        <button className="push" disabled={unread === 0} onClick={() => attempt('notice.read', {})}>
          Mark all read
        </button>
      </div>
      <ul className="roster">
        {notices.map((n) => (
          <li key={n.id}>
            <button className={`notice-row notice-${n.kind} ${n.read ? '' : 'new'}`} onClick={() => go(n)}>
              <span className="row">
                <strong className="cut">{n.title}</strong>
                <time className="faint push">
                  {dayLabel(n.ts) === 'Today' ? '' : `${dayLabel(n.ts)} `}
                  {time(n.ts)}
                </time>
              </span>
              <span className="faint cut2">{n.body}</span>
              {spaces.length > 1 && <span className="faint">{spaces.find((s) => s.id === n.spaceId)?.name}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface UsageRow {
  beeId: string;
  day: string;
  tokensIn: number;
  tokensOut: number;
  turns: number;
}

/** What is left of the plan, and where tokens went. */
export function UsagePane() {
  const guard = useHive((s) => s.guard);
  const bees = useHive((s) => s.bees);
  const lastOrder = useHive((s) => s.orders.length);
  const [rows, setRows] = useState<UsageRow[]>([]);
  const [five, setFive] = useState(String(guard.minFiveHour));
  const [week, setWeek] = useState(String(guard.minWeek));
  useEffect(() => {
    call<UsageRow[]>('usage', { days: 7 }).then(setRows, () => {});
  }, [lastOrder]);
  const days = [...new Set(rows.map((r) => r.day))].sort().reverse();
  const nameOf = (id: string) => bees.find((b) => b.id === id)?.name ?? 'removed bee';
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '');

  return (
    <div className="pane pad stack">
      <h2>Your plan</h2>
      <table>
        <thead>
          <tr>
            <th>Window</th>
            <th>Left</th>
            <th>Resets</th>
            <th>Beekeep stops at</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>5 hours</td>
            <td>{guard.fiveHour === null ? 'unknown' : `${Math.round(guard.fiveHour)}%`}</td>
            <td>{when(guard.resets.fiveHour)}</td>
            <td>
              <input className="tiny" inputMode="numeric" value={five} onChange={(e) => setFive(e.target.value)} aria-label="Stop at percent of 5 hours" /> %
            </td>
          </tr>
          <tr>
            <td>Week</td>
            <td>{guard.week === null ? 'unknown' : `${Math.round(guard.week)}%`}</td>
            <td>{when(guard.resets.week)}</td>
            <td>
              <input className="tiny" inputMode="numeric" value={week} onChange={(e) => setWeek(e.target.value)} aria-label="Stop at percent of week" /> %
            </td>
          </tr>
        </tbody>
      </table>
      <div className="row wrap">
        <button
          className="primary"
          disabled={!(Number(five) >= 0 && Number(week) >= 0)}
          onClick={() => attempt('guard.set', { minFiveHour: Number(five), minWeek: Number(week) })}
        >
          Save limits
        </button>
        <button onClick={() => attempt('guard.check')}>Check now</button>
        <button onClick={() => attempt('guard.set', { paused: !guard.paused })}>{guard.paused ? 'Let bees work' : 'Pause all bees'}</button>
      </div>
      {guard.blocked && <p className="problem">{guard.blocked}</p>}
      {guard.checkedAt === null && <p className="faint">Beekeep reads these numbers with quota-axi. Until it answers, only refusals from Claude itself stop work.</p>}

      <h2>Last 7 days</h2>
      {rows.length === 0 ? (
        <p className="hint">No work yet. Tokens read and written by each bee will be listed here.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Day</th>
              <th>Bee</th>
              <th className="num">Turns</th>
              <th className="num">Read</th>
              <th className="num">Written</th>
            </tr>
          </thead>
          <tbody>
            {days.flatMap((d) =>
              rows
                .filter((r) => r.day === d)
                .sort((a, b) => b.tokensIn - a.tokensIn)
                .map((r, i) => (
                  <tr key={`${d}${r.beeId}`}>
                    <td>{i === 0 ? d : ''}</td>
                    <td>{nameOf(r.beeId)}</td>
                    <td className="num">{r.turns}</td>
                    <td className="num">{thousands(r.tokensIn)}</td>
                    <td className="num">{thousands(r.tokensOut)}</td>
                  </tr>
                )),
            )}
          </tbody>
        </table>
      )}
      <p className="faint">Most tokens read come from Claude’s cache, which counts far less against your plan than fresh ones.</p>
    </div>
  );
}

/** "When this happens, do that." */
export function RulesPane() {
  const rules = useHive((s) => s.automations);
  const bees = useHive((s) => s.bees);
  const space = useHive((s) => s.space);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'daily' | 'every' | 'finished'>('daily');
  const [at, setAt] = useState('09:00');
  const [minutes, setMinutes] = useState('60');
  const [watch, setWatch] = useState('');
  const [status, setStatus] = useState<'done' | 'failed' | 'any'>('done');
  const [then, setThen] = useState<'order' | 'notice'>('order');
  const [beeId, setBeeId] = useState('');
  const [text, setText] = useState('');
  const first = bees[0]?.id ?? '';
  const nameOf = (id: string) => bees.find((b) => b.id === id)?.name ?? 'a removed bee';

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const when =
      kind === 'daily' ? { type: kind, at } : kind === 'every' ? { type: kind, minutes: Number(minutes) } : { type: kind, beeId: watch || first, status };
    const act = then === 'order' ? { type: then, beeId: beeId || first, text } : { type: then, title: text };
    if ((await attempt('automation.save', { spaceId: space, name, enabled: true, when, then: act })) !== undefined) {
      setName('');
      setText('');
    }
  }

  return (
    <div className="pane pad stack">
      {rules.length === 0 && <p className="hint">A rule gives an order or a notice by itself: every morning, every hour, or when a bee finishes. Its orders wait behind yours.</p>}
      {rules.map((r) => (
        <div key={r.id} className="rule">
          <label className="choice">
            <input type="checkbox" checked={r.enabled} onChange={(e) => attempt('automation.save', { ...r, enabled: e.target.checked, lastRun: undefined })} />
            <strong>{r.name}</strong>
          </label>
          <p className="faint">
            {r.when.type === 'daily'
              ? `Every day at ${r.when.at}`
              : r.when.type === 'every'
                ? `Every ${r.when.minutes} minutes`
                : `When ${nameOf(r.when.beeId)} ${r.when.status === 'any' ? 'ends an order' : r.when.status === 'done' ? 'is done' : 'fails'}`}
            , {r.then.type === 'order' ? `order ${nameOf(r.then.beeId)}: ${r.then.text}` : `show "${r.then.title}"`}
          </p>
          <button onClick={() => attempt('automation.remove', { id: r.id })}>Remove</button>
        </div>
      ))}
      <form className="form flat" onSubmit={add}>
        <h2>New rule</h2>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <div className="two">
          <label>
            When
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="daily">Every day at</option>
              <option value="every">Every so many minutes</option>
              <option value="finished">A bee ends an order</option>
            </select>
          </label>
          {kind === 'daily' && (
            <label>
              Time
              <input type="time" value={at} onChange={(e) => setAt(e.target.value)} required />
            </label>
          )}
          {kind === 'every' && (
            <label>
              Minutes (5 or more)
              <input type="number" min={5} value={minutes} onChange={(e) => setMinutes(e.target.value)} required />
            </label>
          )}
          {kind === 'finished' && (
            <label>
              Bee and result
              <span className="row">
                <select value={watch || first} onChange={(e) => setWatch(e.target.value)}>
                  {bees.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
                <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
                  <option value="done">done</option>
                  <option value="failed">failed</option>
                  <option value="any">either</option>
                </select>
              </span>
            </label>
          )}
        </div>
        <div className="two">
          <label>
            Then
            <select value={then} onChange={(e) => setThen(e.target.value as typeof then)}>
              <option value="order">give an order to</option>
              <option value="notice">show a notice</option>
            </select>
          </label>
          {then === 'order' && (
            <label>
              Bee
              <select value={beeId || first} onChange={(e) => setBeeId(e.target.value)}>
                {bees.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <label>
          {then === 'order' ? 'Order' : 'Notice'}
          <textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} required />
        </label>
        <div>
          <button className="primary" type="submit" disabled={then === 'order' && !first}>
            Add rule
          </button>
        </div>
      </form>
    </div>
  );
}

