import { useEffect, useMemo, useRef, useState } from 'react';
import type { Command } from '../../server/types.ts';
import { type PaneKind, resetLayout, saveNow, show, showBee, split, TITLES } from './layout.ts';
import { attempt, call, getState, notify, showSpace, useHive } from './link.ts';

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

/** Type a few letters of what you want. */
export function Palette({ open, onClose, onTask }: { open: boolean; onClose: () => void; onTask: (beeId?: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [text, setText] = useState('');
  const [at, setAt] = useState(0);
  const [commands, setCommands] = useState<Command[]>([]);
  const bees = useHive((s) => s.bees);
  const spaces = useHive((s) => s.spaces);
  const space = useHive((s) => s.space);
  const guard = useHive((s) => s.guard);

  useEffect(() => {
    const d = ref.current!;
    if (open && !d.open) {
      setText('');
      setAt(0);
      d.showModal();
      call<Command[]>('command.list', { space: getState().space }).then(setCommands, () => {});
    }
    if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo<Item[]>(
    () => [
      ...bees.map((b) => ({ label: `Task ${b.name}`, run: () => onTask(b.id) })),
      ...bees.map((b) => ({ label: `Open ${b.name}`, run: () => showBee(b.id) })),
      ...bees
        .filter((b) => b.currentOrderId !== null)
        .map((b) => ({ label: `Stop ${b.name}`, run: () => void attempt('bee.stop', { id: b.id }) })),
      { label: 'New terminal', hint: 'Command T', run: () => show('term') },
      { label: 'New Claude Code pane', run: () => show('term', { termKind: 'claude' }) },
      { label: 'New browser pane', hint: 'Command Shift L', run: () => show('browser', { url: 'about:blank' }) },
      { label: 'Split right', hint: 'Command D', run: () => split('right') },
      { label: 'Split down', hint: 'Command Shift D', run: () => split('below') },
      ...(Object.keys(TITLES) as PaneKind[])
        .filter((k) => !['bee', 'term', 'pick', 'browser'].includes(k))
        .map((k) => ({ label: `Show ${TITLES[k].toLowerCase()}`, run: () => show(k) })),
      ...spaces
        .filter((s) => s.id !== space)
        .map((s) => ({
          label: `Go to ${s.name}`,
          run: () => {
            saveNow();
            showSpace(s.id);
          },
        })),
      ...commands.map((c) => ({
        label: `Run ${c.name}`,
        hint: c.run,
        run: () => (c.trusted ? show('term', { command: c.name }) : notify('Allow this project’s commands first: split a pane and look under Project commands.')),
      })),
      { label: guard.paused ? 'Let bees work' : 'Pause all bees', run: () => void attempt('guard.set', { paused: !guard.paused }) },
      { label: 'Stop all bees now', run: () => void attempt('stopAll') },
      { label: 'Reset panes', run: resetLayout },
    ],
    [bees, spaces, space, commands, guard.paused],
  );

  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const found = items.filter((i) => words.every((w) => i.label.toLowerCase().includes(w))).slice(0, 40);
  const chosen = Math.min(at, Math.max(0, found.length - 1));

  function pick(i: Item | undefined) {
    if (!i) return;
    onClose();
    i.run();
  }

  return (
    <dialog ref={ref} className="dialog palette" onClose={onClose} aria-label="Commands">
      <input
        value={text}
        placeholder="What do you want to do?"
        aria-label="Command"
        onChange={(e) => {
          setText(e.target.value);
          setAt(0);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setAt(Math.min(chosen + 1, found.length - 1));
          else if (e.key === 'ArrowUp') setAt(Math.max(chosen - 1, 0));
          else if (e.key === 'Enter') pick(found[chosen]);
          else return;
          e.preventDefault();
        }}
      />
      <ul role="listbox">
        {found.map((i, n) => (
          <li key={i.label} role="option" aria-selected={n === chosen}>
            <button tabIndex={-1} onClick={() => pick(i)} onMouseMove={() => setAt(n)}>
              <span>{i.label}</span>
              {i.hint && <span className="faint cut">{i.hint}</span>}
            </button>
          </li>
        ))}
        {found.length === 0 && <li className="hint pad">Nothing matches.</li>}
      </ul>
    </dialog>
  );
}
