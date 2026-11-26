import { type FormEvent, useState } from 'react';
import type { SpaceRow } from '../../server/types.ts';
import { shortPath } from './format.ts';
import { saveNow, show } from './layout.ts';
import { attempt, call, showSpace, useHive } from './link.ts';

/** Spaces as vertical tabs, each with what is going on in it. */
export function Sidebar() {
  const spaces = useHive((s) => s.spaces);
  const guard = useHive((s) => s.guard);
  const [adding, setAdding] = useState(false);

  return (
    <nav className="side" aria-label="Spaces">
      <ul>
        {spaces.map((s, i) => (
          <Space key={s.id} space={s} index={i + 1} only={spaces.length === 1} />
        ))}
      </ul>
      {adding ? (
        <SpaceForm onDone={() => setAdding(false)} />
      ) : (
        <button className="side-add" onClick={() => setAdding(true)}>
          New space
        </button>
      )}
      <button className="limits" onClick={() => show('usage')} title="Open usage">
        <Limit name="5 hours" left={guard.fiveHour} stop={guard.minFiveHour} />
        <Limit name="Week" left={guard.week} stop={guard.minWeek} />
      </button>
    </nav>
  );
}

function Limit({ name, left, stop }: { name: string; left: number | null; stop: number }) {
  return (
    <span className="limit">
      <span className="row">
        {name}
        <span className="push">{left === null ? 'unknown' : `${Math.round(left)}% left`}</span>
      </span>
      <span className="meter" aria-hidden="true">
        <span className={left !== null && left < stop ? 'low' : ''} style={{ width: `${left ?? 0}%` }} />
        <i style={{ left: `${stop}%` }} />
      </span>
    </span>
  );
}

function Space({ space, index, only }: { space: SpaceRow; index: number; only: boolean }) {
  const current = useHive((s) => s.space) === space.id;
  const info = useHive((s) => s.spaceInfo[space.id]);
  const bees = useHive((s) => s.bees);
  const terminals = useHive((s) => s.terminals);
  const notices = useHive((s) => s.notices);
  const approvals = useHive((s) => s.approvals);
  const plans = useHive((s) => s.plans);
  const home = useHive((s) => s.defaults.home);
  const [editing, setEditing] = useState(false);

  const mine = bees.filter((b) => b.spaceId === space.id);
  const ids = new Set(mine.map((b) => b.id));
  const unread = notices.filter((n) => !n.read && n.spaceId === space.id);
  const needs =
    approvals.filter((a) => ids.has(a.beeId)).length +
    plans.filter((p) => p.spaceId === space.id && p.status === 'proposed').length +
    terminals.filter((t) => t.spaceId === space.id && t.agent === 'needs you').length;
  const working =
    mine.filter((b) => b.currentOrderId !== null).length + terminals.filter((t) => t.spaceId === space.id && t.agent === 'working').length;

  if (editing) {
    return (
      <li>
        <SpaceForm space={space} only={only} onDone={() => setEditing(false)} />
      </li>
    );
  }
  return (
    <li>
      <button
        className={`space mark-${space.mark} ${current ? 'current' : ''} ${needs ? 'needs' : unread.length ? 'fresh' : ''}`}
        aria-current={current}
        onClick={() => {
          saveNow();
          showSpace(space.id);
        }}
        onDoubleClick={() => setEditing(true)}
        title={`${shortPath(space.folder, home)}. Double-click to edit. Command ${index}`}
      >
        <span className="row">
          <i className="dot" aria-hidden="true" />
          <strong className="cut">{space.name}</strong>
          {needs > 0 ? <span className="count push">{needs}</span> : working > 0 ? <span className="push working">working</span> : null}
        </span>
        {info?.branch && (
          <span className="faint cut">
            {info.branch}
            {info.changes > 0 && `, ${info.changes} changed`}
          </span>
        )}
        {info?.pr && (
          <span className="faint cut">
            PR {info.pr.number} {info.pr.state}
            {info.pr.checks && `, ${info.pr.checks}`}
          </span>
        )}
        {info && info.ports.length > 0 && <span className="faint cut">ports {info.ports.join(', ')}</span>}
        {unread[0] && <span className="latest cut">{unread[0].title}</span>}
      </button>
    </li>
  );
}

function SpaceForm({ space, only, onDone }: { space?: SpaceRow; only?: boolean; onDone: () => void }) {
  const home = useHive((s) => s.defaults.home);
  const [name, setName] = useState(space?.name ?? '');
  const [folder, setFolder] = useState(space ? shortPath(space.folder, home) : '~/');
  const [problem, setProblem] = useState<string | null>(null);
  const [sure, setSure] = useState(false);

  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      if (space) await call('space.update', { id: space.id, name, folder });
      else {
        const made = await call<SpaceRow>('space.create', { name, folder });
        saveNow();
        showSpace(made.id);
      }
      onDone();
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  return (
    <form className="form" onSubmit={save}>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={60} />
      </label>
      <label>
        Folder
        <input value={folder} onChange={(e) => setFolder(e.target.value)} required spellCheck={false} />
      </label>
      {problem && <p className="problem">{problem}</p>}
      <div className="row wrap">
        <button className="primary">{space ? 'Save' : 'Add space'}</button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        {space && !only && (
          <button
            type="button"
            className="stop"
            title="Its bees and terminals move to another space"
            onClick={() => (sure ? void attempt('space.remove', { id: space.id }).then(onDone) : setSure(true))}
          >
            {sure ? 'Yes, remove' : 'Remove'}
          </button>
        )}
      </div>
    </form>
  );
}
