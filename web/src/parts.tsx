import { useState } from 'react';
import type { ApprovalRow, BeeView, PlanRow } from '../../server/types.ts';
import { canAlways, STATUS_WORD, toolDetail, toolWord } from './format.ts';
import { attempt, useHive } from './link.ts';

/**
 * A comb cell with the bee's paint dot. Beekeepers mark queens with one of five
 * colours; here the dot says which bee, and the cell says what it is doing.
 */
export function Cell({ bee, size = 28 }: { bee: BeeView; size?: number }) {
  return (
    <svg
      className={`cell cell-${bee.status} mark-${bee.mark} kind-${bee.kind}`}
      width={size}
      height={size}
      viewBox="0 0 32 32"
      aria-hidden="true"
    >
      <path className="cell-wall" d="M16 1.8 28.3 8.9v14.2L16 30.2 3.7 23.1V8.9z" />
      <circle className="cell-dot" cx="16" cy="16" r="8" />
      <text className="cell-letter" x="16" y="16.5" textAnchor="middle" dominantBaseline="central">
        {bee.name[0]?.toUpperCase()}
      </text>
    </svg>
  );
}

export function Status({ bee }: { bee: BeeView }) {
  return <span className={`status status-${bee.status}`}>{STATUS_WORD[bee.status]}</span>;
}

/** One thing a bee needs the person for: a yes, an answer, or a look at its plan. */
export function Ask({ ask, bee }: { ask: ApprovalRow; bee: BeeView | undefined }) {
  if (ask.tool === 'AskUserQuestion') return <Question ask={ask} bee={bee} />;
  return <Permission ask={ask} bee={bee} />;
}

function Permission({ ask, bee }: { ask: ApprovalRow; bee: BeeView | undefined }) {
  const [note, setNote] = useState('');
  const plan = ask.tool === 'ExitPlanMode';
  const decide = (allow: boolean, always = false) => attempt('approval.decide', { id: ask.id, allow, always, note: note || undefined });
  return (
    <section className="ask" aria-label={`${bee?.name ?? 'A bee'} needs your approval`}>
      <p className="ask-title">
        <strong>{bee?.name ?? 'A removed bee'}</strong> {plan ? 'has a plan' : `wants to use ${toolWord(ask.tool)}`}
      </p>
      <p className="ask-reason">{ask.reason}</p>
      <pre className={plan ? 'ask-detail ask-plan' : 'ask-detail'}>{toolDetail(ask.tool, ask.input)}</pre>
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="If you refuse, say why (optional)" aria-label="Reason for refusing" />
      <div className="row wrap">
        <button className="primary" onClick={() => decide(true)}>
          {plan ? 'Go ahead' : 'Allow once'}
        </button>
        {canAlways(ask) && <button onClick={() => decide(true, true)}>{canAlways(ask)}</button>}
        <button onClick={() => decide(false)}>{plan ? 'Keep planning' : 'Refuse'}</button>
      </div>
    </section>
  );
}

interface QuestionInput {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

function Question({ ask, bee }: { ask: ApprovalRow; bee: BeeView | undefined }) {
  const questions = (ask.input.questions ?? []) as QuestionInput[];
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const answers = Object.fromEntries(
    questions.map((q) => [q.question, [...(picked[q.question] ?? []), other[q.question]?.trim()].filter(Boolean).join(', ')]),
  );
  const complete = questions.every((q) => answers[q.question]);

  function toggle(q: QuestionInput, label: string) {
    setPicked((p) => {
      const now = p[q.question] ?? [];
      const next = now.includes(label) ? now.filter((l) => l !== label) : q.multiSelect ? [...now, label] : [label];
      return { ...p, [q.question]: next };
    });
  }

  return (
    <section className="ask" aria-label={`${bee?.name ?? 'A bee'} asks you`}>
      <p className="ask-title">
        <strong>{bee?.name ?? 'A removed bee'}</strong> asks
      </p>
      {questions.map((q) => (
        <fieldset key={q.question} className="question">
          <legend>{q.question}</legend>
          {q.options.map((o) => (
            <label key={o.label} className="choice">
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={`${ask.id}-${q.question}`}
                checked={(picked[q.question] ?? []).includes(o.label)}
                onChange={() => toggle(q, o.label)}
              />
              <span>
                {o.label}
                {o.description && <span className="faint"> {o.description}</span>}
              </span>
            </label>
          ))}
          <input
            value={other[q.question] ?? ''}
            onChange={(e) => setOther({ ...other, [q.question]: e.target.value })}
            placeholder="Something else"
            aria-label={`Other answer to ${q.question}`}
          />
        </fieldset>
      ))}
      <div className="row">
        <button className="primary" disabled={!complete} onClick={() => attempt('approval.decide', { id: ask.id, allow: true, answers })}>
          Answer
        </button>
        <button onClick={() => attempt('approval.decide', { id: ask.id, allow: false })}>Skip</button>
      </div>
    </section>
  );
}

/** A queen's plan waiting for a yes. */
export function PlanAsk({ plan }: { plan: PlanRow }) {
  const bees = useHive((s) => s.bees);
  const allTasks = useHive((s) => s.tasks);
  const [note, setNote] = useState('');
  const tasks = allTasks.filter((t) => t.planId === plan.id);
  const queen = bees.find((b) => b.id === plan.queenId);
  const nameOf = (id: string) => bees.find((b) => b.id === id)?.name ?? 'removed bee';
  const needs = [...new Set(tasks.filter((t) => t.files.length).map((t) => t.beeId))]
    .map((id) => bees.find((b) => b.id === id))
    .filter((b): b is BeeView => b?.mode === 'look');

  return (
    <section className="ask" aria-label="A plan needs your yes">
      <p className="ask-title">
        <strong>{queen?.name ?? 'A queen'}</strong> proposes a plan
      </p>
      <p>{plan.goal}</p>
      <ol className="plan-tasks">
        {tasks.map((t) => (
          <li key={t.id}>
            <details>
              <summary>
                <strong>{t.title}</strong>
                <span className="faint">
                  {' '}
                  {nameOf(t.beeId)}
                  {t.deps.length > 0 && `, after ${t.deps.join(' and ')}`}
                  {t.files.length > 0 && `, owns ${t.files.join(', ')}`}
                </span>
              </summary>
              <pre className="ask-detail">{t.brief}</pre>
            </details>
          </li>
        ))}
      </ol>
      <p className="faint">
        At most {plan.limits.orders} orders, {plan.limits.wakeups} queen wake-ups and {plan.limits.minutes} minutes.
      </p>
      {needs.length > 0 && (
        <p>
          {needs.map((n) => n.name).join(' and ')} can only look right now, so this plan cannot write its files without your
          permission.
        </p>
      )}
      <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should change? (sent if you refuse)" aria-label="What should change" />
      <div className="row wrap">
        {needs.length > 0 ? (
          <>
            <button className="primary" onClick={() => attempt('plan.approve', { id: plan.id, upgrade: true })}>
              Let {needs.map((n) => n.name).join(' and ')} edit files, and start
            </button>
            <button onClick={() => attempt('plan.approve', { id: plan.id })}>Start without that</button>
          </>
        ) : (
          <button className="primary" onClick={() => attempt('plan.approve', { id: plan.id })}>
            Start plan
          </button>
        )}
        <button onClick={() => attempt('plan.refuse', { id: plan.id, note: note || undefined })}>Refuse</button>
      </div>
    </section>
  );
}

export function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d={d} />
    </svg>
  );
}

export const ICON = {
  right: 'M2 3h12v10H2zM9 3v10',
  down: 'M2 3h12v10H2zM2 9h12',
  full: 'M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4',
  close: 'M4 4l8 8M12 4l-8 8',
  back: 'M10 3L5 8l5 5',
  forward: 'M6 3l5 5-5 5',
  reload: 'M13 8a5 5 0 1 1-1.6-3.7M13 2v3h-3',
  up: 'M5 8l3-4 3 4M8 4v9',
  thumb: 'M5 7l3-5c1 0 1.6.8 1.4 1.8L9 6h4l-1 7H5zM5 7H2v6h3',
  side: 'M2 3h12v10H2zM6 3v10',
};
