// Opening, splitting and remembering panes. Each space has its own arrangement.
import type { DockviewApi } from 'dockview-react';
import { getState, keepLayout, showSpace } from './link.ts';

export type PaneKind =
  | 'bees' | 'bee' | 'term' | 'approvals' | 'pick' | 'plans' | 'board' | 'map' | 'notices' | 'usage' | 'rules' | 'browser';

export interface PaneParams {
  beeId?: string;
  termId?: string;
  browserId?: string;
  url?: string;
  termKind?: 'shell' | 'claude' | 'ssh';
  host?: string;
  run?: string;
  cwd?: string;
  command?: string;
}

export const TITLES: Record<PaneKind, string> = {
  bees: 'All bees',
  bee: 'Bee',
  term: 'Terminal',
  approvals: 'Needs you',
  pick: 'New pane',
  plans: 'Plans',
  board: 'Board',
  map: 'Map',
  notices: 'Notices',
  usage: 'Usage',
  rules: 'Rules',
  browser: 'Browser',
};

const SINGLE = new Set<PaneKind>(['bees', 'approvals', 'plans', 'board', 'map', 'notices', 'usage', 'rules']);

let dock: DockviewApi | null = null;
let dockSpace = '';
let saveTimer: ReturnType<typeof setTimeout> | undefined;

/** Panes that make sense only once share one id. */
function paneId(kind: PaneKind, p: PaneParams): string {
  if (SINGLE.has(kind)) return kind;
  if (kind === 'bee') return `bee-${p.beeId}`;
  return `${kind}-${crypto.randomUUID().slice(0, 8)}`;
}

type Where = { referencePanel: string; direction: 'left' | 'right' | 'above' | 'below' | 'within' };

function open(kind: PaneKind, params: PaneParams = {}, position?: Where, size: { initialWidth?: number; initialHeight?: number } = {}) {
  const id = paneId(kind, params);
  const existing = dock!.getPanel(id);
  if (existing) {
    existing.api.setActive();
    return existing;
  }
  const title =
    kind === 'bee'
      ? (getState().bees.find((b) => b.id === params.beeId)?.name ?? TITLES.bee)
      : params.termKind === 'claude'
        ? 'Claude Code'
        : TITLES[kind];
  return dock!.addPanel({ id, component: kind, title, params, position, ...size });
}

/** Opens something in the active group, or where an empty pane waits. */
export function show(kind: PaneKind, params: PaneParams = {}): void {
  if (!dock) return;
  const pick = dock.panels.find((p) => p.id.startsWith('pick-'));
  if (pick && !dock.getPanel(paneId(kind, params))) return openIn(pick.id, kind, params);
  // A cramped corner is no place to read; use the roomiest group then.
  const area = (g: { element: HTMLElement }) => g.element.clientWidth * g.element.clientHeight;
  const here = dock.activePanel?.group;
  const roomy = here && here.element.clientWidth >= 420 ? here : [...dock.groups].sort((a, b) => area(b) - area(a))[0];
  const ref = roomy?.activePanel ?? dock.activePanel;
  open(kind, params, ref ? { referencePanel: ref.id, direction: 'within' } : undefined);
}

/** Replaces a "New pane" with what was chosen. */
export function openIn(pickId: string, kind: PaneKind, params: PaneParams = {}): void {
  const pick = dock!.getPanel(pickId);
  open(kind, params, pick ? { referencePanel: pickId, direction: 'within' } : undefined);
  pick?.api.close();
}

export function showBee(beeId: string): void {
  const bee = getState().bees.find((b) => b.id === beeId);
  if (bee && bee.spaceId !== getState().space) showSpace(bee.spaceId);
  // Reuse an empty pane, else share a tab group with another bee, else split off the list.
  requestAnimationFrame(() => {
    if (!dock) return;
    const pick = dock.panels.find((p) => p.id.startsWith('pick-'));
    if (pick && !dock.getPanel(`bee-${beeId}`)) return openIn(pick.id, 'bee', { beeId });
    const other = dock.panels.find((p) => p.id.startsWith('bee-'));
    if (other) return void open('bee', { beeId }, { referencePanel: other.id, direction: 'within' });
    open('bee', { beeId }, dock.getPanel('bees') ? { referencePanel: 'bees', direction: 'right' } : undefined);
  });
}

/** Goes to whatever a notice is about. */
export function goTo(spaceId: string, source: string): void {
  if (spaceId !== getState().space && getState().spaces.some((s) => s.id === spaceId)) showSpace(spaceId);
  const [what, id] = source.split(':');
  setTimeout(() => {
    if (what === 'bee' && id) showBee(id);
    else if (what === 'plan') show('plans');
    else if (what === 'term' && id) {
      const panel = dock?.panels.find((p) => (p.params as PaneParams | undefined)?.termId === id);
      if (panel) panel.api.setActive();
      else if (getState().terminals.some((t) => t.id === id)) show('term', { termId: id });
    }
  }, 60);
}

/** Whether a terminal or browser already has a pane in this space. */
export function onScreen(key: 'termId' | 'browserId', id: string): boolean {
  return !!dock?.panels.some((p) => (p.params as PaneParams | undefined)?.[key] === id);
}

export function split(direction: 'right' | 'below', from?: string): void {
  const base = from ?? dock?.activePanel?.id;
  open('pick', {}, base ? { referencePanel: base, direction } : undefined);
}

export function activePane(): { kind: PaneKind; params: PaneParams } | null {
  const p = dock?.activePanel;
  return p ? { kind: p.id.split('-')[0] as PaneKind, params: (p.params ?? {}) as PaneParams } : null;
}

export function closeActive(): void {
  dock?.activePanel?.api.close();
}

/** Next or previous tab in the active group. */
export function cycle(by: 1 | -1): void {
  const group = dock?.activeGroup;
  if (!group || group.panels.length < 2) return;
  const at = group.panels.findIndex((p) => p.id === group.activePanel?.id);
  group.panels[(at + by + group.panels.length) % group.panels.length]!.api.setActive();
}

/** The nearest pane in a direction, by where it is on screen. */
export function focusToward(way: 'left' | 'right' | 'up' | 'down'): void {
  const from = dock?.activeGroup;
  if (!from) return;
  const a = from.element.getBoundingClientRect();
  const center = (r: DOMRect) => [r.left + r.width / 2, r.top + r.height / 2] as const;
  const [ax, ay] = center(a);
  let best: { d: number; go: () => void } | null = null;
  for (const g of dock!.groups) {
    if (g.id === from.id) continue;
    const [bx, by] = center(g.element.getBoundingClientRect());
    const dx = bx - ax;
    const dy = by - ay;
    const ahead = way === 'left' ? -dx : way === 'right' ? dx : way === 'up' ? -dy : dy;
    const aside = way === 'left' || way === 'right' ? Math.abs(dy) : Math.abs(dx);
    if (ahead <= 10) continue;
    const d = ahead + aside * 2;
    if (!best || d < best.d) best = { d, go: () => g.activePanel?.api.setActive() };
  }
  best?.go();
}

function fresh(): void {
  dock!.clear();
  open('bees');
  const main = open('pick', {}, { referencePanel: 'bees', direction: 'right' });
  open('term', {}, { referencePanel: main.id, direction: 'below' }, { initialHeight: 240 });
  open('map', {}, { referencePanel: 'bees', direction: 'below' }, { initialHeight: 320 });
  dock!.getPanel('bees')!.group.api.setSize({ width: 300 });
  main.api.setActive();
}

export function ready(api: DockviewApi, space: string): void {
  dock = api;
  dockSpace = space;
  try {
    const saved = getState().layouts[space];
    if (!saved) throw new Error('No saved layout.');
    api.fromJSON(saved as never);
    if (api.panels.length === 0) throw new Error('Saved layout is empty.');
  } catch {
    fresh();
  }
  api.onDidLayoutChange(() => {
    clearTimeout(saveTimer);
    const here = dockSpace;
    saveTimer = setTimeout(() => dock === api && keepLayout(here, api.toJSON()), 400);
  });
}

/** Before switching spaces, so nothing arranged in the last moment is lost. */
export function saveNow(): void {
  clearTimeout(saveTimer);
  if (dock && dockSpace) keepLayout(dockSpace, dock.toJSON());
}

export function resetLayout(): void {
  fresh();
}
