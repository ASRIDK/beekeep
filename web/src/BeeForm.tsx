import { type FormEvent, useEffect, useState } from 'react';
import { type Abilities, type BeeKind, type BeeMode, type BeeView, NO_ABILITIES } from '../../server/types.ts';
import { shortPath } from './format.ts';
import { call, notify, useHive } from './link.ts';

/** Make a bee, or change one. */
export function BeeForm({ bee, onDone }: { bee?: BeeView; onDone: (made: BeeView | null) => void }) {
  const defaults = useHive((s) => s.defaults);
  const space = useHive((s) => s.space);
  const spaces = useHive((s) => s.spaces);
  const folder = spaces.find((s) => s.id === space)?.folder ?? defaults.workspace;
  const [name, setName] = useState(bee?.name ?? '');
  const [kind, setKind] = useState<BeeKind>(bee?.kind ?? 'worker');
  const [role, setRole] = useState(bee?.role ?? '');
  const [agent, setAgent] = useState(bee?.agent ?? 'claude');
  const [model, setModel] = useState(bee?.model ?? 'haiku');
  const [effort, setEffort] = useState(bee?.effort ?? '');
  const [mode, setMode] = useState<BeeMode>(bee?.mode ?? 'look');
  const [workspace, setWorkspace] = useState(shortPath(bee?.workspace ?? folder, defaults.home));
  const [spaceId, setSpaceId] = useState(bee?.spaceId ?? space);
  const [can, setCan] = useState<Abilities>(bee?.abilities ?? { ...NO_ABILITIES, shell: false });
  const [grants, setGrants] = useState(bee?.grants ?? []);
  const [autoPlan, setAutoPlan] = useState(bee?.autoPlan ?? false);
  const [confined, setConfined] = useState(bee?.confined ?? true);
  const [ownCopy, setOwnCopy] = useState(bee?.origin != null);
  const [copy, setCopy] = useState<{ branch: string; commits: number; changes: number; path: string; origin: string } | null>(null);
  useEffect(() => {
    if (bee?.origin) call<typeof copy>('bee.copy', { id: bee.id }).then(setCopy, () => {});
  }, [bee?.id, bee?.origin]);
  const [brought, setBrought] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [sure, setSure] = useState<'remove' | 'forget' | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    const fields = { agent, name, kind, role, model, effort: effort || null, mode, workspace, spaceId, abilities: can, autoPlan, confined, ownCopy };
    setSaving(true);
    setProblem(null);
    try {
      onDone(bee ? await call<BeeView>('bee.update', { id: bee.id, ...fields, grants }) : await call<BeeView>('bee.create', fields));
    } catch (err) {
      setProblem((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function act(what: 'remove' | 'forget') {
    if (sure !== what) return setSure(what);
    try {
      const kept = await call<string | null>(`bee.${what}`, { id: bee!.id });
      if (kept) notify(kept);
      onDone(null);
    } catch (err) {
      setProblem((err as Error).message);
    }
  }

  const flip = (list: 'mcp' | 'skills', item: string) =>
    setCan((c) => ({ ...c, [list]: c[list].includes(item) ? c[list].filter((x) => x !== item) : [...c[list], item] }));

  return (
    <form className="form" onSubmit={save}>
      <div className="two">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required autoFocus={!bee} />
        </label>
        <label>
          Job
          <select
            value={kind}
            onChange={(e) => {
              const k = e.target.value as BeeKind;
              setKind(k);
              if (!bee) setModel(k === 'queen' ? 'sonnet' : 'haiku');
            }}
          >
            <option value="worker">Worker: does tasks</option>
            <option value="queen">Queen: plans and leads</option>
          </select>
        </label>
      </div>
      <label>
        Role (optional)
        <textarea rows={2} value={role} onChange={(e) => setRole(e.target.value)} placeholder="Find sources and check dates" />
      </label>
      <label>
        Agent
        <select
          value={agent}
          onChange={(e) => {
            const next = e.target.value as typeof agent;
            setAgent(next);
            setModel(next === 'codex' ? 'default' : 'haiku');
            if (next === 'codex') setKind('worker');
          }}
        >
          {defaults.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <div className="two">
        <label>
          Model
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {(defaults.agents.find((a) => a.id === agent)?.models ?? defaults.models).map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Effort
          <select value={effort} onChange={(e) => setEffort(e.target.value)}>
            <option value="">usual</option>
            {defaults.efforts.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
      </div>
      <label>
        May do
        <select value={mode} onChange={(e) => setMode(e.target.value as BeeMode)}>
          <option value="look">Look: read and search (lightest)</option>
          <option value="work">Work: also edit files in its folder</option>
          <option value="full">Full: every Claude Code tool, same approvals (heaviest)</option>
        </select>
      </label>
      <div className="two">
        <label>
          Folder it works in
          <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} required spellCheck={false} disabled={bee?.origin != null} />
        </label>
        <label>
          Space
          <select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>
            {spaces.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="choice">
        <input type="checkbox" checked={ownCopy} onChange={(e) => setOwnCopy(e.target.checked)} />
        <span>
          Work in its own git copy <span className="faint">a separate branch, so your files stay untouched</span>
        </span>
      </label>
      {copy && (
        <p className="faint">
          Branch {copy.branch}, {copy.commits} {copy.commits === 1 ? 'commit' : 'commits'}, {copy.changes} uncommitted.{' '}
          <button
            type="button"
            className="inline"
            disabled={copy.commits === 0}
            onClick={() =>
              call('bee.bring', { id: bee!.id }).then(
                () => {
                  setBrought(true);
                  setProblem(null);
                },
                (err: Error) => setProblem(err.message),
              )
            }
          >
            Bring into my repository
          </button>{' '}
          {brought ? (
            <>
              It is there now. To use it, in {shortPath(copy.origin, defaults.home)}: <code>git merge {copy.branch}</code>
            </>
          ) : (
            'Commits arrive as a branch; nothing of yours changes until you merge it.'
          )}
        </p>
      )}
      {mode !== 'look' && (
        <label className="choice">
          <input type="checkbox" checked={can.shell} onChange={(e) => setCan({ ...can, shell: e.target.checked })} />
          <span>
            Run shell commands, each with your yes <span className="faint">makes it about twice as heavy</span>
          </span>
        </label>
      )}
      {mode !== 'look' && can.shell && (
        <label className="choice">
          <input type="checkbox" checked={confined} onChange={(e) => setConfined(e.target.checked)} />
          <span>
            Confine its shell commands <span className="faint">they can change only its folder and cannot read your keys</span>
          </span>
        </label>
      )}

      <details className="more">
        <summary>Abilities (each one makes the bee heavier)</summary>
        <label className="choice">
          <input type="checkbox" checked={can.browser} onChange={(e) => setCan({ ...can, browser: e.target.checked })} />
          <span>Use the browser pane</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={can.questions} onChange={(e) => setCan({ ...can, questions: e.target.checked })} />
          <span>Ask you multiple-choice questions</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={can.helpers} onChange={(e) => setCan({ ...can, helpers: e.target.checked })} />
          <span>Start short-lived helpers (shown in its actions)</span>
        </label>
        <label className="choice">
          <input type="checkbox" checked={can.project} onChange={(e) => setCan({ ...can, project: e.target.checked })} />
          <span>
            Load the folder’s own Claude setup <span className="faint">CLAUDE.md, skills, and hooks that run code</span>
          </span>
        </label>
        {defaults.mcp.length > 0 && (
          <fieldset className="question">
            <legend>MCP servers</legend>
            {defaults.mcp.map((m) => (
              <label key={m.name} className="choice">
                <input type="checkbox" checked={can.mcp.includes(m.name)} onChange={() => flip('mcp', m.name)} />
                <span>
                  {m.name} <span className="faint">{m.type}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {defaults.skills.length > 0 && (
          <fieldset className="question">
            <legend>Skills</legend>
            {defaults.skills.map((m) => (
              <label key={m.name} className="choice" title={m.about}>
                <input type="checkbox" checked={can.skills.includes(m.name)} onChange={() => flip('skills', m.name)} />
                <span>{m.name}</span>
              </label>
            ))}
          </fieldset>
        )}
      </details>

      {kind === 'queen' && (
        <label className="choice">
          <input type="checkbox" checked={autoPlan} onChange={(e) => setAutoPlan(e.target.checked)} />
          <span>
            Start her plans without asking <span className="faint">limits and approvals still apply</span>
          </span>
        </label>
      )}

      {grants.length > 0 && (
        <fieldset className="question">
          <legend>Always allowed</legend>
          {grants.map((g) => (
            <div key={`${g.tool} ${g.match}`} className="row">
              <code className="cut">
                {g.tool} {g.match}
              </code>
              <button type="button" onClick={() => setGrants(grants.filter((x) => x !== g))}>
                Take back
              </button>
            </div>
          ))}
        </fieldset>
      )}

      {problem && (
        <p className="problem" role="alert">
          {problem}
        </p>
      )}
      <div className="row wrap">
        <button className="primary" type="submit" disabled={saving}>
          {saving && ownCopy && !bee?.origin ? 'Making its copy' : bee ? 'Save changes' : 'Add bee'}
        </button>
        <button type="button" onClick={() => onDone(null)}>
          Cancel
        </button>
        {bee && (
          <span className="row push">
            <button type="button" onClick={() => act('forget')} title="It forgets the conversation; the history here stays">
              {sure === 'forget' ? 'Yes, clear it' : 'Clear memory'}
            </button>
            <button type="button" className="stop" onClick={() => act('remove')}>
              {sure === 'remove' ? 'Yes, remove it' : 'Remove bee'}
            </button>
          </span>
        )}
      </div>
    </form>
  );
}
