// The window's side of the socket: one live copy of the hive, shared by every pane.
import { useSyncExternalStore } from 'react';
import type { EventRow, MessageRow, Snapshot } from '../../server/types.ts';

export type Phase = 'connecting' | 'live' | 'lost' | 'locked' | 'stopped';

export interface State extends Omit<Snapshot, 'currentSpace'> {
  phase: Phase;
  /** The space this window shows. */
  space: string;
  events: Record<string, EventRow[]>;
  /** Whether older history exists that has not been loaded. */
  older: Record<string, boolean>;
  typing: Record<string, string>;
  /** Recent bee-to-bee messages, for the map. */
  flying: MessageRow[];
  notice: { text: string; problem: boolean } | null;
}

let state: State = {
  phase: 'connecting',
  space: 'main',
  bees: [],
  orders: [],
  approvals: [],
  plans: [],
  tasks: [],
  board: [],
  links: [],
  notices: [],
  spaces: [],
  spaceInfo: {},
  terminals: [],
  browsers: [],
  automations: [],
  guard: {
    fiveHour: null, week: null, resets: { fiveHour: null, week: null }, minFiveHour: 20, minWeek: 10,
    blocked: null, paused: false, overrideUntil: null, checkedAt: null,
  },
  layouts: {},
  defaults: { workspace: '', home: '', models: [], efforts: [], mcp: [], skills: [] },
  events: {},
  older: {},
  typing: {},
  flying: [],
  notice: null,
};

const listeners = new Set<() => void>();

function set(change: Partial<State>): void {
  state = { ...state, ...change };
  for (const l of listeners) l();
}

/** Reads part of the hive. `pick` must return existing parts of the state, not new objects. */
export function useHive<T>(pick: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => pick(state),
  );
}

export const getState = () => state;

export function showSpace(id: string): void {
  if (id === state.space) return;
  set({ space: id });
  void attempt('space.current', { id });
}

export function keepLayout(space: string, layout: unknown): void {
  state = { ...state, layouts: { ...state.layouts, [space]: layout } };
  call('layout.save', { space, layout }).catch(() => {});
}

// Socket

const TOKEN_KEY = 'hive-token';
const PAGE = 200;

let ws: WebSocket | null = null;
let nextId = 1;
let retry = 0;
let sessionToken: string | null = null;
const pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
const termListeners = new Map<string, Set<(data: string) => void>>();
const frameListeners = new Map<string, (f: { data: string; width: number; height: number }) => void>();
const reconnectListeners = new Set<() => void>();

function savedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Trades the one-time code in the address for this launch's secret. */
async function claim(): Promise<void> {
  const code = /^#c=(.+)$/.exec(location.hash)?.[1];
  if (!code) return;
  history.replaceState(null, '', '/');
  const res = await fetch('/claim', { method: 'POST', body: JSON.stringify({ code }) });
  if (!res.ok) return;
  sessionToken = ((await res.json()) as { token: string }).token;
  try {
    localStorage.setItem(TOKEN_KEY, sessionToken);
  } catch {
    // Without storage the window works until it is reloaded.
  }
}

export async function start(): Promise<void> {
  await claim().catch(() => {});
  connect();
  // A Mac app window that is already open gets a new code by changing the address.
  window.addEventListener('hashchange', () => void claim().then(() => state.phase === 'locked' && connect()));
  const focus = () => void call('focus', { on: document.hasFocus() }).catch(() => {});
  window.addEventListener('focus', focus);
  window.addEventListener('blur', focus);
}

function connect(): void {
  const token = sessionToken ?? savedToken();
  if (!token) return set({ phase: 'locked' });
  const sock = new WebSocket(`ws://${location.host}/socket`);
  ws = sock;

  sock.onopen = async () => {
    try {
      await call('hello', undefined, { token });
      const { currentSpace, ...snap } = await call<Snapshot>('snapshot');
      retry = 0;
      const again = state.phase !== 'connecting';
      const space = again && snap.spaces.some((s) => s.id === state.space) ? state.space : currentSpace;
      set({ ...snap, space, phase: 'live', typing: {} });
      call('focus', { on: document.hasFocus() }).catch(() => {});
      if (again) {
        for (const beeId of Object.keys(state.events)) void loadEvents(beeId);
        for (const l of reconnectListeners) l();
      }
    } catch {
      // The close handler decides what happens next.
    }
  };
  sock.onmessage = (e) => receive(JSON.parse(e.data as string));
  sock.onclose = (e) => {
    if (ws !== sock) return;
    ws = null;
    for (const p of pending.values()) p.fail(new Error('The connection to Beekeep was lost.'));
    pending.clear();
    if (e.code === 4401) {
      sessionToken = null;
      return set({ phase: 'locked' });
    }
    if (e.code === 4000) {
      // Stopped on purpose: nothing to wait for. Browsers may refuse to close a window.
      set({ phase: 'stopped' });
      const mac = (window as { webkit?: { messageHandlers?: { quit?: { postMessage: (x: null) => void } } } }).webkit;
      if (mac?.messageHandlers?.quit) mac.messageHandlers.quit.postMessage(null);
      else window.close();
      return;
    }
    set({ phase: 'lost' });
    retry += 1;
    setTimeout(connect, Math.min(500 * retry, 5000));
  };
}

export function call<T = unknown>(op: string, args?: unknown, extra: object = {}): Promise<T> {
  const sock = ws;
  if (!sock || sock.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Beekeep is not connected.'));
  const id = nextId++;
  return new Promise<T>((ok, fail) => {
    pending.set(id, { ok: ok as (v: unknown) => void, fail });
    sock.send(JSON.stringify({ id, op, args, ...extra }));
  });
}

/** Like call, but shows what went wrong instead of throwing. Resolves to undefined on failure. */
export async function attempt<T = unknown>(op: string, args?: unknown): Promise<T | undefined> {
  try {
    return await call<T>(op, args);
  } catch (err) {
    notify((err as Error).message, true);
    return undefined;
  }
}

let noticeTimer: ReturnType<typeof setTimeout> | undefined;

export function notify(text: string | null, problem = false): void {
  clearTimeout(noticeTimer);
  set({ notice: text ? { text, problem } : null });
  if (text) noticeTimer = setTimeout(() => set({ notice: null }), 8000);
}

type Parts = Partial<
  Pick<
    State,
    | 'bees' | 'orders' | 'approvals' | 'plans' | 'tasks' | 'board' | 'links' | 'notices' | 'spaces' | 'spaceInfo'
    | 'terminals' | 'browsers' | 'automations' | 'guard'
  >
>;

type Push =
  | { re: number; ok: true; data: unknown }
  | { re: number; ok: false; error: string }
  | { re?: undefined; ev: 'event'; event: EventRow }
  | { re?: undefined; ev: 'typing'; beeId: string; text: string }
  | { re?: undefined; ev: 'message'; message: MessageRow }
  | { re?: undefined; ev: 'term'; id: string; data: string }
  | { re?: undefined; ev: 'frame'; id: string; data: string; width: number; height: number }
  | ({ re?: undefined; ev: 'part' } & Parts);

function receive(m: Push): void {
  if (m.re !== undefined) {
    const p = pending.get(m.re);
    pending.delete(m.re);
    if (m.ok) p?.ok(m.data);
    else p?.fail(new Error(m.error));
    return;
  }
  switch (m.ev) {
    case 'typing':
      return set({ typing: { ...state.typing, [m.beeId]: (state.typing[m.beeId] ?? '') + m.text } });
    case 'term':
      for (const l of termListeners.get(m.id) ?? []) l(m.data);
      return;
    case 'frame':
      return frameListeners.get(m.id)?.(m);
    case 'event':
      return addEvents(m.event.beeId, [m.event]);
    case 'message':
      return set({ flying: [...state.flying.slice(-20), m.message] });
    default: {
      // The rest are whole parts of the state, named as they are here.
      const { ev: _, ...parts } = m as { ev: string } & Parts;
      if (parts.spaces && !parts.spaces.some((s) => s.id === state.space)) {
        set({ ...parts, space: parts.spaces[0]!.id });
      } else {
        set(parts);
      }
    }
  }
}

function addEvents(beeId: string, rows: EventRow[]): void {
  const typing = { ...state.typing };
  if (rows.some((e) => e.kind === 'say' || e.kind === 'turn' || e.kind === 'order')) delete typing[beeId];
  const known = state.events[beeId];
  // A bee nobody has opened is loaded from the server when its pane opens.
  if (!known) return set({ typing });
  const byId = new Map([...known, ...rows].map((e) => [e.id, e]));
  const merged = [...byId.values()].sort((a, b) => a.id - b.id);
  set({ typing, events: { ...state.events, [beeId]: merged } });
}

export async function loadEvents(beeId: string): Promise<void> {
  const rows = await attempt<EventRow[]>('events', { beeId, limit: PAGE });
  if (!rows) return;
  set({
    events: { ...state.events, [beeId]: state.events[beeId] ?? [] },
    older: { ...state.older, [beeId]: rows.length === PAGE },
  });
  addEvents(beeId, rows);
}

export async function loadOlder(beeId: string): Promise<void> {
  const first = state.events[beeId]?.[0];
  if (!first) return;
  const rows = await attempt<EventRow[]>('events', { beeId, before: first.id, limit: PAGE });
  if (!rows) return;
  set({ older: { ...state.older, [beeId]: rows.length === PAGE } });
  addEvents(beeId, rows);
}

export function onTerm(id: string, l: (data: string) => void): () => void {
  const group = termListeners.get(id) ?? new Set();
  termListeners.set(id, group.add(l));
  return () => {
    group.delete(l);
    if (group.size === 0) termListeners.delete(id);
  };
}

export function onFrame(id: string, l: (f: { data: string; width: number; height: number }) => void): () => void {
  frameListeners.set(id, l);
  return () => frameListeners.delete(id);
}

export function onReconnect(l: () => void): () => void {
  reconnectListeners.add(l);
  return () => reconnectListeners.delete(l);
}
