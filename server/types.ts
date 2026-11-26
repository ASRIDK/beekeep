// Shapes shared by the server and the window.

export type BeeMode = 'look' | 'work' | 'full';
export type BeeKind = 'worker' | 'queen';
export type BeeStatus = 'off' | 'idle' | 'busy' | 'waiting' | 'stopping' | 'error';
export type OrderStatus = 'queued' | 'running' | 'done' | 'failed' | 'stopped' | 'cancelled';
export type ApprovalStatus = 'waiting' | 'allowed' | 'denied' | 'expired';

/** Optional parts of Claude Code a bee carries. Each one costs tokens, so all are off at first. */
export interface Abilities {
  /** Names of the person's own MCP servers. */
  mcp: string[];
  /** Names of the person's own skills. */
  skills: string[];
  /** The folder's own Claude Code setup: CLAUDE.md, skills, hooks. */
  project: boolean;
  /** May start short-lived helpers (subagents). */
  helpers: boolean;
  /** May ask multiple-choice questions. */
  questions: boolean;
  /** May use the shared browser. */
  browser: boolean;
  /** May run shell commands, each with a yes. The heaviest single ability. */
  shell: boolean;
}

/** A standing yes the person gave to one bee. */
export interface Grant {
  tool: string;
  /** Exact command, site or nothing, depending on the tool. */
  match?: string;
}

export interface BeeRow {
  id: string;
  spaceId: string;
  name: string;
  kind: BeeKind;
  role: string;
  model: string;
  effort: string | null;
  mode: BeeMode;
  workspace: string;
  sessionId: string | null;
  /** Which paint dot the bee wears, 0 to 4. */
  mark: number;
  abilities: Abilities;
  grants: Grant[];
  /** Queen only: run her plans without asking first. */
  autoPlan: boolean;
  /** Approved shell commands run in a sandbox: they can change only its folder. */
  confined: boolean;
  /** Set when the bee works in its own git copy: the folder it was copied from. */
  origin: string | null;
  branch: string | null;
  createdAt: number;
}

export interface BeeView extends BeeRow {
  status: BeeStatus;
  currentOrderId: number | null;
  detail: string | null;
}

export interface OrderRow {
  id: number;
  beeId: string;
  /** 'you', 'hive' (news for a queen), 'auto' (automation), 'outside' (MCP or command line), or a bee's id. */
  source: string;
  text: string;
  priority: number;
  status: OrderStatus;
  taskId: number | null;
  planId: number | null;
  /** Make a plan and wait for a yes before changing anything. */
  planFirst: boolean;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export type EventKind =
  | 'order'
  | 'say'
  | 'think'
  | 'action'
  | 'result'
  | 'turn'
  | 'approval'
  | 'decision'
  | 'limit'
  | 'session'
  | 'note'
  | 'error'
  | 'message'
  | 'other';

export interface EventRow {
  id: number;
  beeId: string;
  ts: number;
  kind: EventKind;
  data: Record<string, unknown>;
}

export interface ApprovalRow {
  id: number;
  beeId: string;
  tool: string;
  input: Record<string, unknown>;
  reason: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt: number | null;
}

export type PlanStatus = 'proposed' | 'running' | 'done' | 'failed' | 'stopped' | 'refused';
export type TaskStatus = 'planned' | 'waiting' | 'running' | 'done' | 'failed' | 'stopped';

export interface PlanRow {
  id: number;
  spaceId: string;
  queenId: string;
  goal: string;
  status: PlanStatus;
  /** What the plan may spend before it stops itself. */
  limits: { orders: number; wakeups: number; minutes: number };
  used: { orders: number; wakeups: number; tokens: number };
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface TaskRow {
  id: number;
  planId: number;
  key: string;
  title: string;
  brief: string;
  beeId: string;
  deps: string[];
  /** Files this task owns, relative to the bee's folder. Empty means no claim. */
  files: string[];
  status: TaskStatus;
  orderId: number | null;
  report: string | null;
  score: number | null;
  createdAt: number;
  endedAt: number | null;
}

/** Something on the shared board. */
export interface BoardRow {
  id: number;
  spaceId: string;
  author: string;
  topic: string;
  text: string;
  ts: number;
}

/** How well messages or orders from one to the other have worked, 0.1 to 1. */
export interface LinkRow {
  from: string;
  to: string;
  weight: number;
  uses: number;
}

export interface MessageRow {
  id: number;
  from: string;
  to: string;
  text: string;
  ts: number;
  delivered: boolean;
  orderId: number | null;
}

export interface SpaceRow {
  id: string;
  name: string;
  folder: string;
  mark: number;
  position: number;
}

/** Live facts about a space's folder. */
export interface SpaceInfo {
  branch: string | null;
  changes: number;
  pr: { number: number; state: string; url: string; checks: string | null } | null;
  ports: number[];
}

export type NoticeKind = 'needs' | 'done' | 'problem' | 'info';

export interface NoticeRow {
  id: number;
  spaceId: string;
  kind: NoticeKind;
  /** 'bee:<id>', 'term:<id>', 'plan:<id>' or 'hive'. */
  source: string;
  title: string;
  body: string;
  ts: number;
  read: boolean;
}

export type TermKind = 'shell' | 'claude' | 'ssh';

export interface TermView {
  id: string;
  spaceId: string;
  kind: TermKind;
  cwd: string;
  /** SSH only: where it connects. */
  host: string | null;
  title: string;
  alive: boolean;
  /** Claude panes only: what its hooks last reported. */
  agent: 'working' | 'needs you' | 'ready' | null;
}

export interface BrowserView {
  id: string;
  spaceId: string;
  url: string;
  title: string;
}

export interface AutomationRow {
  id: number;
  spaceId: string;
  name: string;
  enabled: boolean;
  when:
    | { type: 'finished'; beeId: string; status: 'done' | 'failed' | 'any' }
    | { type: 'every'; minutes: number }
    | { type: 'daily'; at: string };
  then: { type: 'order'; beeId: string; text: string } | { type: 'notice'; title: string };
  lastRun: number | null;
}

export interface GuardState {
  /** Percent of the plan's windows left, when known. */
  fiveHour: number | null;
  week: number | null;
  resets: { fiveHour: string | null; week: string | null };
  minFiveHour: number;
  minWeek: number;
  /** Why new work is held back, if it is. */
  blocked: string | null;
  paused: boolean;
  overrideUntil: number | null;
  checkedAt: number | null;
}

export interface Command {
  name: string;
  run: string;
  space: string;
  /** Where it was defined, so the person can judge it. */
  file: string;
  trusted: boolean;
}

export interface Snapshot {
  bees: BeeView[];
  orders: OrderRow[];
  approvals: ApprovalRow[];
  plans: PlanRow[];
  tasks: TaskRow[];
  board: BoardRow[];
  links: LinkRow[];
  notices: NoticeRow[];
  spaces: SpaceRow[];
  spaceInfo: Record<string, SpaceInfo>;
  terminals: TermView[];
  browsers: BrowserView[];
  automations: AutomationRow[];
  guard: GuardState;
  layouts: Record<string, unknown>;
  currentSpace: string;
  defaults: {
    workspace: string;
    home: string;
    models: { id: string; label: string }[];
    efforts: string[];
    mcp: { name: string; type: string }[];
    skills: { name: string; about: string }[];
  };
}

export const PRIORITY = { now: 2, you: 1, bee: 0 } as const;

export const MODELS = [
  { id: 'haiku', label: 'Haiku 5.5 (light)' },
  { id: 'sonnet', label: 'Sonnet 5.5 (middle)' },
  { id: 'opus', label: 'Opus 5.5 (heavy)' },
];

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

export const NO_ABILITIES: Abilities = {
  mcp: [],
  skills: [],
  project: false,
  helpers: false,
  questions: false,
  browser: false,
  // Bees from before this was a choice had it.
  shell: true,
};

export const PLAN_LIMITS = { orders: 20, wakeups: 8, minutes: 60 };
