// The terminal screen: every bee at a glance, a few of them side by side, and
// one place to answer what they ask. The bees keep working when it is closed.
import { Box, render, Text, useApp, useInput, useStdout } from 'ink';
import { createElement as h, type ReactNode, useEffect, useReducer, useState } from 'react';
import { type Abilities, type BeeView, NO_ABILITIES } from '../server/types.ts';
import { canAlways } from '../web/src/format.ts';
import { approvalLines, beeLabel, GLYPH, type Line, paneLines, plain, planLines, statusWord } from './format.ts';
import type { Link } from './link.ts';

const SIDE = 26;
const MAX_SHOWN = 3;

type Mode =
  | { kind: 'normal' }
  | { kind: 'order'; beeId: string; text: string; planFirst: boolean }
  | { kind: 'new'; field: number; bee: NewBee }
  | { kind: 'plan' }
  | { kind: 'help' };

interface NewBee {
  name: string;
  kind: 'worker' | 'queen';
  model: string;
  mode: 'look' | 'work' | 'full';
  shell: boolean;
}

const CHOICES = {
  kind: ['worker', 'queen'],
  model: ['haiku', 'sonnet', 'opus'],
  mode: ['look', 'work', 'full'],
  shell: [false, true],
} as const;
const FIELDS = ['name', 'kind', 'model', 'mode', 'shell'] as const;

const abilities = (shell: boolean): Abilities => ({ ...NO_ABILITIES, shell });

function show(line: Line, key: number | string): ReactNode {
  return h(Text, { key, color: line.color, dimColor: line.dim, bold: line.bold, wrap: 'truncate-end' }, line.text || ' ');
}

function useView(link: Link) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    // Many events can arrive at once; draw at most twenty times a second.
    const soon = () => (timer ??= setTimeout(() => ((timer = null), redraw()), 50));
    link.on('change', soon);
    return () => void link.off('change', soon);
  }, [link]);
  return link.view!;
}

function App({ link, openWindow }: { link: Link; openWindow: () => Promise<void> }) {
  const v = useView(link);
  const { exit } = useApp();
  const stdout = useStdout().stdout as NodeJS.WriteStream;
  const [size, setSize] = useState({ cols: stdout.columns || 100, rows: stdout.rows || 30 });
  const [sel, setSel] = useState(0);
  const [shown, setShown] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: 'normal' });
  const [ask, setAsk] = useState(0);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => {
    const resize = () => setSize({ cols: stdout.columns, rows: stdout.rows });
    stdout.on('resize', resize);
    return () => void stdout.off('resize', resize);
  }, [stdout]);

  const bees = v.bees;
  const cur = bees[Math.min(sel, bees.length - 1)];
  // The chosen bee is always on screen; pinned ones stay beside it.
  const ids = cur && !shown.includes(cur.id) ? [...shown, cur.id].slice(-MAX_SHOWN) : shown;
  const panes = ids.map((id) => bees.find((b) => b.id === id)).filter((b) => b !== undefined);
  useEffect(() => {
    for (const b of panes) void link.watch(b.id).catch(() => {});
  });

  const asks = v.approvals.filter((a) => a.status === 'waiting');
  const approval = asks[ask % Math.max(1, asks.length)];
  const plan = v.plans.find((p) => p.status === 'proposed');

  const say = (text: string, bad = false) => setNote({ text, bad });
  // Good news fades; problems stay until the next action.
  useEffect(() => {
    if (!note || note.bad) return;
    const t = setTimeout(() => setNote(null), 6000);
    return () => clearTimeout(t);
  }, [note]);
  const run = (op: string, args: unknown, done?: string) =>
    link.call(op, args).then(
      () => (done ? say(done) : setNote(null)),
      (err: Error) => say(err.message, true),
    );

  useInput((input, key) => {
    if (key.ctrl && input === 'c') return exit();
    if (mode.kind === 'order') {
      if (key.escape) return setMode({ kind: 'normal' });
      if (key.tab) return setMode({ ...mode, planFirst: !mode.planFirst });
      if (key.return) {
        const text = mode.text.trim();
        setMode({ kind: 'normal' });
        if (!text) return;
        const now = text.startsWith('!');
        void run('order.send', { beeId: mode.beeId, text: now ? text.slice(1).trim() : text, now, planFirst: mode.planFirst }, now ? 'Stopped what it was doing; your order goes first.' : undefined);
        return;
      }
      if (key.backspace || key.delete) return setMode({ ...mode, text: mode.text.slice(0, -1) });
      if (input && !key.ctrl && !key.meta) setMode({ ...mode, text: mode.text + input.replace(/[\r\n]+/g, ' ') });
      return;
    }
    if (mode.kind === 'new') {
      const field = FIELDS[mode.field]!;
      const bee = mode.bee;
      if (key.escape) return setMode({ kind: 'normal' });
      if (key.upArrow || (key.shift && key.tab)) return setMode({ ...mode, field: (mode.field + FIELDS.length - 1) % FIELDS.length });
      if (key.downArrow || key.tab) return setMode({ ...mode, field: (mode.field + 1) % FIELDS.length });
      if (key.return) {
        setMode({ kind: 'normal' });
        void run(
          'bee.create',
          { name: bee.name.trim(), kind: bee.kind, model: bee.model, mode: bee.mode, workspace: v.defaults.workspace, abilities: abilities(bee.shell) },
          `${bee.name.trim()} joined the hive.`,
        );
        return;
      }
      if (field === 'name') {
        if (key.backspace || key.delete) return setMode({ ...mode, bee: { ...bee, name: bee.name.slice(0, -1) } });
        if (input && !key.ctrl && !key.meta) setMode({ ...mode, bee: { ...bee, name: (bee.name + input).slice(0, 40) } });
        return;
      }
      if (key.leftArrow || key.rightArrow || input === ' ') {
        const list = CHOICES[field] as readonly (string | boolean)[];
        const at = list.indexOf(bee[field]);
        const next = list[(at + (key.leftArrow ? list.length - 1 : 1)) % list.length];
        setMode({ ...mode, bee: { ...bee, [field]: next } });
      }
      return;
    }
    if (mode.kind === 'plan') {
      if (key.escape || input === 'p') return setMode({ kind: 'normal' });
      if (!plan) return setMode({ kind: 'normal' });
      if (input === 'y') {
        setMode({ kind: 'normal' });
        return void run('plan.approve', { id: plan.id }, 'Plan started.');
      }
      if (input === 'u') {
        setMode({ kind: 'normal' });
        return void run('plan.approve', { id: plan.id, upgrade: true }, 'Plan started; its bees may now edit files.');
      }
      if (input === 'n') {
        setMode({ kind: 'normal' });
        return void run('plan.refuse', { id: plan.id }, 'Plan refused. The queen hears it.');
      }
      return;
    }
    if (mode.kind === 'help') return setMode({ kind: 'normal' });

    // Normal
    if (input === 'q') return exit();
    if (input === '?') return setMode({ kind: 'help' });
    if (key.upArrow || input === 'k') return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow || input === 'j') return setSel((s) => Math.min(bees.length - 1, s + 1));
    if (input === '+' || input === 'c') {
      return setMode({ kind: 'new', field: 0, bee: { name: `Worker ${bees.length}`, kind: 'worker', model: 'haiku', mode: 'work', shell: false } });
    }
    if (bees.length === 0 && key.return) return void starter();
    if (input === 'w') return void openWindow().then(() => say('Opened the window.'), (err: Error) => say(err.message, true));
    if (approval && (input === 'y' || input === 'n' || input === 'a')) {
      const always = input === 'a';
      if (always && !canAlways(approval)) return say('This can only be allowed once.', true);
      setAsk(0);
      return void run('approval.decide', { id: approval.id, allow: input !== 'n', always });
    }
    if (key.tab && asks.length > 1) return setAsk((n) => n + 1);
    if (input === 'p') return plan ? setMode({ kind: 'plan' }) : say('No plan is waiting for you.');
    if (!cur) return;
    if (key.return || input === 'o') return setMode({ kind: 'order', beeId: cur.id, text: '', planFirst: false });
    if (input === ' ') return setShown(shown.includes(cur.id) ? shown.filter((id) => id !== cur.id) : [...shown, cur.id].slice(-MAX_SHOWN));
    if (input === 's') return void run('bee.stop', { id: cur.id }, `Asked ${cur.name} to stop.`);
    if (input === 'x') return void run('stopAll', {}, 'Asked every bee to stop.');
  });

  async function starter() {
    const ws = v.defaults.workspace;
    try {
      await link.call('bee.create', { name: 'Queen', kind: 'queen', model: 'sonnet', mode: 'look', workspace: ws, abilities: abilities(false) });
      for (const name of ['Worker 1', 'Worker 2']) {
        await link.call('bee.create', { name, kind: 'worker', model: 'haiku', mode: 'work', workspace: ws, abilities: abilities(false) });
      }
      say(`Your hive is ready in ${ws}. Select the Queen and give her a goal, or give a worker a job.`);
    } catch (err) {
      say((err as Error).message, true);
    }
  }

  // Layout
  const { cols, rows } = size;
  const working = bees.filter((b) => b.status === 'busy').length;
  const g = v.guard;
  const limits = g.fiveHour !== null ? `  5-hour ${g.fiveHour}% left${g.week !== null ? ` · week ${g.week}% left` : ''}` : '';
  const header = h(
    Box,
    { justifyContent: 'space-between' },
    h(Text, null, h(Text, { bold: true, color: 'yellow' }, ' beekeep '), ` ${bees.length} bees · ${working} working`, asks.length ? h(Text, { color: 'magenta' }, ` · ${asks.length} need you`) : null, h(Text, { dimColor: true }, limits)),
    h(Text, { dimColor: true }, g.blocked ? h(Text, { color: 'red' }, `held: ${plain(g.blocked)} `) : null, '? help  q quit '),
  );

  const bottom: ReactNode[] = [];
  const width = cols - 4;
  if (mode.kind === 'order') {
    const to = bees.find((b) => b.id === mode.beeId);
    bottom.push(
      h(Box, { key: 'order', borderStyle: 'round', borderColor: 'cyan', flexDirection: 'column', paddingX: 1 },
        h(Text, null, h(Text, { color: 'cyan', bold: true }, `Order for ${plain(to?.name ?? '')} › `), mode.text, h(Text, { inverse: true }, ' ')),
        h(Text, { dimColor: true }, `Enter send · Esc cancel · Tab plan first: ${mode.planFirst ? 'on' : 'off'} · start with ! to stop it and do this now`),
      ),
    );
  } else if (approval) {
    const label = canAlways(approval);
    bottom.push(
      h(Box, { key: 'ask', borderStyle: 'round', borderColor: 'magenta', flexDirection: 'column', paddingX: 1 },
        ...approvalLines(approval, bees, width, Math.max(2, Math.floor(rows / 5))).map(show),
        h(Text, { color: 'magenta' }, `y yes · n no${label ? ` · a ${label.toLowerCase()}` : ''}${asks.length > 1 ? ` · Tab next (${(ask % asks.length) + 1}/${asks.length})` : ''}`),
      ),
    );
  } else if (plan && mode.kind !== 'plan') {
    bottom.push(h(Box, { key: 'plan', paddingX: 1 }, h(Text, { color: 'yellow' }, `◆ ${plain(bees.find((b) => b.id === plan.queenId)?.name ?? 'The queen')} has a plan for you. Press p to see it.`)));
  }
  if (note) bottom.push(h(Box, { key: 'note', paddingX: 1 }, h(Text, { color: note.bad ? 'red' : 'green', wrap: 'truncate-end' }, plain(note.text))));

  let main: ReactNode;
  const bodyRows = Math.max(5, rows - 1 - (mode.kind === 'order' ? 4 : approval ? Math.min(rows / 2, 6 + Math.floor(rows / 5)) : plan ? 1 : 0) - (note ? 1 : 0));
  if (mode.kind === 'help') {
    main = h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 1, flexGrow: 1 },
      h(Text, { bold: true }, 'Keys'),
      ...[
        ['↑ ↓  or  k j', 'choose a bee'],
        ['Enter or o', 'give the chosen bee an order (start it with ! to stop what it does and do this now)'],
        ['Space', 'pin the chosen bee, so it stays on screen beside the next one (up to 3)'],
        ['y  n  a', 'answer what a bee asks: yes, no, always (where that is safe)'],
        ['Tab', 'next question, when several bees ask'],
        ['p', 'see the queen’s plan: y start it, u start and let its bees edit, n refuse'],
        ['+', 'add a bee'],
        ['s / x', 'stop the chosen bee / stop every bee'],
        ['w', 'open the full window in your browser'],
        ['q', 'leave this screen; bees keep working (beekeep stop ends them)'],
      ].map(([k, d]) => h(Text, { key: k }, h(Text, { color: 'cyan' }, k!.padEnd(14)), d)),
      h(Text, { dimColor: true }, ' '),
      h(Text, { dimColor: true }, 'Press any key to go back.'),
    );
  } else if (mode.kind === 'new') {
    const b = mode.bee;
    const value = (f: (typeof FIELDS)[number]) =>
      f === 'name' ? b.name + (mode.field === 0 ? '█' : '') : f === 'shell' ? (b.shell ? 'yes (heavier, each command asks you)' : 'no') : String(b[f]);
    const words = { name: 'Name', kind: 'Job', model: 'Model', mode: 'May do', shell: 'Shell' } as const;
    main = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1, flexGrow: 1 },
      h(Text, { bold: true }, 'New bee'),
      ...FIELDS.map((f, i) => h(Text, { key: f, inverse: i === mode.field }, ` ${words[f].padEnd(8)} ${value(f)} `)),
      h(Text, { dimColor: true }, ' '),
      h(Text, { dimColor: true }, `Works in ${plain(v.defaults.workspace)}. look: reads only · work: may edit its folder · full: all of Claude Code's tools.`),
      h(Text, { dimColor: true }, '↑ ↓ field · ← → change · Enter add · Esc cancel'),
    );
  } else if (mode.kind === 'plan' && plan) {
    main = h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, flexGrow: 1 },
      ...planLines(plan, v.tasks.filter((t) => t.planId === plan.id), bees, width).slice(0, bodyRows - 4).map(show),
      h(Text, { dimColor: true }, ' '),
      h(Text, { color: 'yellow' }, 'y start it · u start and let its bees edit files · n refuse · Esc back'),
    );
  } else if (bees.length === 0) {
    main = h(Box, { flexDirection: 'column', borderStyle: 'round', paddingX: 2, paddingY: 1, flexGrow: 1 },
      h(Text, { bold: true }, 'No bees yet.'),
      h(Text, null, ' '),
      h(Text, null, 'Press Enter for a starter hive: a queen on Sonnet who plans, and two workers on Haiku who do the work.'),
      h(Text, null, `They work in ${plain(v.defaults.workspace)}, use your own Claude Code login, and ask you before anything risky.`),
      h(Text, null, ' '),
      h(Text, { dimColor: true }, 'Or press + to add one bee yourself.'),
    );
  } else {
    const paneWidth = Math.floor((cols - SIDE) / Math.max(1, panes.length)) - 4;
    main = h(Box, { flexGrow: 1 },
      ...panes.map((b) =>
        h(Box, { key: b.id, flexDirection: 'column', borderStyle: 'round', borderColor: b.id === cur?.id ? 'cyan' : 'gray', paddingX: 1, flexGrow: 1, flexBasis: 0, overflow: 'hidden' },
          h(Text, { wrap: 'truncate-end' }, h(Text, { bold: true }, beeLabel(b)), h(Text, { dimColor: true }, ` · ${b.model} · ${b.mode}`), h(Text, { color: GLYPH[b.status].color }, ` · ${statusWord(b)}`)),
          ...paneLines(v.events[b.id] ?? [], b, v.typing[b.id] ?? '', paneWidth, bodyRows - 3).map(show),
        ),
      ),
    );
  }

  const side = h(Box, { flexDirection: 'column', width: SIDE, borderStyle: 'round', borderColor: 'gray', paddingX: 1 },
    h(Text, { bold: true }, 'Bees'),
    ...bees.map((b, i) =>
      h(Text, { key: b.id, inverse: i === sel, wrap: 'truncate-end' },
        h(Text, { color: GLYPH[b.status].color }, `${GLYPH[b.status].mark} `),
        beeLabel(b),
        shown.includes(b.id) ? h(Text, { dimColor: true }, ' ▣') : null,
      ),
    ),
    h(Text, null, ' '),
    plan ? h(Text, { color: 'yellow' }, '◆ plan waiting (p)') : null,
    ...v.plans.filter((p) => p.status === 'running').slice(0, 3).map((p) => {
      const ts = v.tasks.filter((t) => t.planId === p.id);
      return h(Text, { key: p.id, dimColor: true, wrap: 'truncate-end' }, `▶ ${ts.filter((t) => t.status === 'done').length}/${ts.length} ${plain(p.goal)}`);
    }),
    h(Box, { flexGrow: 1 }),
    h(Text, { dimColor: true }, '+ add · ? keys'),
  );

  return h(Box, { flexDirection: 'column', width: cols, height: rows },
    header,
    h(Box, { flexGrow: 1 }, side, main),
    ...bottom,
  );
}

/** Takes over the terminal until the person leaves; the bees keep working. */
export async function runScreen(link: Link, openWindow: () => Promise<void>): Promise<void> {
  await link.connect();
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[H'); // A screen of its own, as full-screen programs do.
  let reason = '';
  const app = render(h(App, { link, openWindow }), { exitOnCtrlC: false });
  link.on('closed', (code: number) => {
    reason = code === 4000 ? 'Beekeep was stopped.' : 'The connection to Beekeep was lost. Run beekeep to open it again.';
    app.unmount();
  });
  try {
    await app.waitUntilExit();
  } finally {
    out.write('\x1b[?1049l');
    link.close();
    if (reason) console.log(reason);
  }
}
