import { existsSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import {
  type ApprovalRow,
  type ApprovalStatus,
  type AutomationRow,
  type BeeRow,
  type BoardRow,
  type EventKind,
  type EventRow,
  type LinkRow,
  type MessageRow,
  NO_ABILITIES,
  type NoticeKind,
  type NoticeRow,
  type OrderRow,
  type OrderStatus,
  type PlanRow,
  type PlanStatus,
  type SpaceRow,
  type TaskRow,
  type TaskStatus,
} from './types.ts';

// Each step brings older data forward. Never edit a step that has shipped; add one.
const STEPS: string[] = [
  `
CREATE TABLE IF NOT EXISTS bees (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
  mode TEXT NOT NULL, workspace TEXT NOT NULL, session_id TEXT, mark INTEGER NOT NULL, created_at INTEGER NOT NULL,
  removed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL, ts INTEGER NOT NULL,
  kind TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_by_bee ON events (bee_id, id);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL, source TEXT NOT NULL, text TEXT NOT NULL,
  priority INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_by_status ON orders (status);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, bee_id TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  `
ALTER TABLE bees ADD COLUMN space_id TEXT NOT NULL DEFAULT 'main';
ALTER TABLE bees ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker';
ALTER TABLE bees ADD COLUMN effort TEXT;
ALTER TABLE bees ADD COLUMN abilities TEXT NOT NULL DEFAULT '{}';
ALTER TABLE bees ADD COLUMN grants TEXT NOT NULL DEFAULT '[]';
ALTER TABLE bees ADD COLUMN auto_plan INTEGER NOT NULL DEFAULT 0;
UPDATE bees SET kind = 'queen' WHERE lower(name) = 'queen';
ALTER TABLE orders ADD COLUMN task_id INTEGER;
ALTER TABLE orders ADD COLUMN plan_id INTEGER;
ALTER TABLE orders ADD COLUMN plan_first INTEGER NOT NULL DEFAULT 0;
CREATE TABLE spaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL, mark INTEGER NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL, queen_id TEXT NOT NULL, goal TEXT NOT NULL,
  status TEXT NOT NULL, limits TEXT NOT NULL, used TEXT NOT NULL, created_at INTEGER NOT NULL,
  started_at INTEGER, ended_at INTEGER
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, plan_id INTEGER NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
  brief TEXT NOT NULL, bee_id TEXT NOT NULL, deps TEXT NOT NULL, files TEXT NOT NULL, status TEXT NOT NULL,
  order_id INTEGER, report TEXT, score REAL, created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX tasks_by_plan ON tasks (plan_id);
CREATE TABLE board (
  id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL, author TEXT NOT NULL, topic TEXT NOT NULL,
  text TEXT NOT NULL, ts INTEGER NOT NULL
);
CREATE TABLE links (
  from_id TEXT NOT NULL, to_id TEXT NOT NULL, weight REAL NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (from_id, to_id)
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, from_id TEXT NOT NULL, to_id TEXT NOT NULL, text TEXT NOT NULL,
  ts INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0, order_id INTEGER
);
CREATE TABLE notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL, kind TEXT NOT NULL, source TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, ts INTEGER NOT NULL, read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE automations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, space_id TEXT NOT NULL, name TEXT NOT NULL, enabled INTEGER NOT NULL,
  rule TEXT NOT NULL, last_run INTEGER
);
CREATE TABLE terms (
  id TEXT PRIMARY KEY, space_id TEXT NOT NULL, kind TEXT NOT NULL, cwd TEXT NOT NULL, session_id TEXT,
  screen TEXT NOT NULL DEFAULT '', cols INTEGER NOT NULL DEFAULT 80, rows INTEGER NOT NULL DEFAULT 24,
  created_at INTEGER NOT NULL
);
`,
  `
ALTER TABLE bees ADD COLUMN confined INTEGER NOT NULL DEFAULT 1;
ALTER TABLE bees ADD COLUMN origin TEXT;
ALTER TABLE bees ADD COLUMN branch TEXT;
ALTER TABLE terms ADD COLUMN host TEXT;
`,
];

type Row = Record<string, unknown>;
const json = (v: unknown) => JSON.parse(v as string);

const toBee = (r: Row): BeeRow => ({
  id: r.id as string,
  spaceId: r.space_id as string,
  name: r.name as string,
  kind: r.kind as BeeRow['kind'],
  role: r.role as string,
  model: r.model as string,
  effort: (r.effort as string | null) ?? null,
  mode: r.mode as BeeRow['mode'],
  workspace: r.workspace as string,
  sessionId: (r.session_id as string | null) ?? null,
  mark: r.mark as number,
  abilities: { ...NO_ABILITIES, ...json(r.abilities) },
  grants: json(r.grants),
  autoPlan: r.auto_plan === 1,
  confined: r.confined === 1,
  origin: (r.origin as string | null) ?? null,
  branch: (r.branch as string | null) ?? null,
  createdAt: r.created_at as number,
});

const toOrder = (r: Row): OrderRow => ({
  id: r.id as number,
  beeId: r.bee_id as string,
  source: r.source as string,
  text: r.text as string,
  priority: r.priority as number,
  status: r.status as OrderStatus,
  taskId: r.task_id as number | null,
  planId: r.plan_id as number | null,
  planFirst: r.plan_first === 1,
  createdAt: r.created_at as number,
  startedAt: r.started_at as number | null,
  endedAt: r.ended_at as number | null,
});

const toEvent = (r: Row): EventRow => ({
  id: r.id as number,
  beeId: r.bee_id as string,
  ts: r.ts as number,
  kind: r.kind as EventKind,
  data: json(r.data),
});

const toApproval = (r: Row): ApprovalRow => ({
  id: r.id as number,
  beeId: r.bee_id as string,
  tool: r.tool as string,
  input: json(r.input),
  reason: r.reason as string,
  status: r.status as ApprovalStatus,
  createdAt: r.created_at as number,
  decidedAt: r.decided_at as number | null,
});

const toPlan = (r: Row): PlanRow => ({
  id: r.id as number,
  spaceId: r.space_id as string,
  queenId: r.queen_id as string,
  goal: r.goal as string,
  status: r.status as PlanStatus,
  limits: json(r.limits),
  used: json(r.used),
  createdAt: r.created_at as number,
  startedAt: r.started_at as number | null,
  endedAt: r.ended_at as number | null,
});

const toTask = (r: Row): TaskRow => ({
  id: r.id as number,
  planId: r.plan_id as number,
  key: r.key as string,
  title: r.title as string,
  brief: r.brief as string,
  beeId: r.bee_id as string,
  deps: json(r.deps),
  files: json(r.files),
  status: r.status as TaskStatus,
  orderId: r.order_id as number | null,
  report: r.report as string | null,
  score: r.score as number | null,
  createdAt: r.created_at as number,
  endedAt: r.ended_at as number | null,
});

const toBoard = (r: Row): BoardRow => ({
  id: r.id as number,
  spaceId: r.space_id as string,
  author: r.author as string,
  topic: r.topic as string,
  text: r.text as string,
  ts: r.ts as number,
});

const toLink = (r: Row): LinkRow => ({
  from: r.from_id as string,
  to: r.to_id as string,
  weight: r.weight as number,
  uses: r.uses as number,
});

const toMessage = (r: Row): MessageRow => ({
  id: r.id as number,
  from: r.from_id as string,
  to: r.to_id as string,
  text: r.text as string,
  ts: r.ts as number,
  delivered: r.delivered === 1,
  orderId: r.order_id as number | null,
});

const toNotice = (r: Row): NoticeRow => ({
  id: r.id as number,
  spaceId: r.space_id as string,
  kind: r.kind as NoticeKind,
  source: r.source as string,
  title: r.title as string,
  body: r.body as string,
  ts: r.ts as number,
  read: r.read === 1,
});

const toSpace = (r: Row): SpaceRow => ({
  id: r.id as string,
  name: r.name as string,
  folder: r.folder as string,
  mark: r.mark as number,
  position: r.position as number,
});

const toAutomation = (r: Row): AutomationRow => ({
  id: r.id as number,
  spaceId: r.space_id as string,
  name: r.name as string,
  enabled: r.enabled === 1,
  ...json(r.rule),
  lastRun: r.last_run as number | null,
});

export interface SavedTerm {
  id: string;
  spaceId: string;
  kind: 'shell' | 'claude' | 'ssh';
  cwd: string;
  host: string | null;
  sessionId: string | null;
  screen: string;
  cols: number;
  rows: number;
}

/** Everything that must survive a restart. Events are only ever added. */
export class Store {
  private db: DatabaseSync;

  constructor(file: string) {
    const old = existsSync(file);
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate(file, old);
  }

  private migrate(file: string, old: boolean): void {
    let version = this.one('PRAGMA user_version')!.user_version as number;
    // Data from before versions were numbered is step 1.
    if (version === 0 && this.one("SELECT 1 FROM sqlite_master WHERE name = 'bees'")) version = 1;
    if (old && version > 0 && version < STEPS.length) {
      const copy = `${file}.before-v${STEPS.length}`;
      if (!existsSync(copy)) this.db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
    }
    for (let v = version; v < STEPS.length; v++) {
      this.db.exec('BEGIN');
      try {
        this.db.exec(STEPS[v]!);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec('COMMIT');
      } catch (err) {
        this.db.exec('ROLLBACK');
        throw err;
      }
    }
  }

  close(): void {
    this.db.close();
  }

  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.db.prepare(sql).get(...args) as Row | undefined;
  }

  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...args) as Row[];
  }

  private run(sql: string, ...args: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...args).lastInsertRowid);
  }

  // Spaces

  spaces(): SpaceRow[] {
    return this.all('SELECT * FROM spaces ORDER BY position, rowid').map(toSpace);
  }

  saveSpace(s: SpaceRow): void {
    this.run(
      `INSERT INTO spaces (id, name, folder, mark, position) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, folder = excluded.folder, mark = excluded.mark,
       position = excluded.position`,
      s.id, s.name, s.folder, s.mark, s.position,
    );
  }

  removeSpace(id: string): void {
    this.run('DELETE FROM spaces WHERE id = ?', id);
  }

  // Bees

  bees(): BeeRow[] {
    return this.all('SELECT * FROM bees WHERE removed = 0 ORDER BY created_at, rowid').map(toBee);
  }

  /** Bees ever made, including removed ones, so paint dots do not shift. */
  beeCount(): number {
    return this.one('SELECT count(*) AS n FROM bees')!.n as number;
  }

  addBee(b: BeeRow): void {
    this.run(
      `INSERT INTO bees (id, space_id, name, kind, role, model, effort, mode, workspace, session_id, mark, abilities,
       grants, auto_plan, confined, origin, branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      b.id, b.spaceId, b.name, b.kind, b.role, b.model, b.effort, b.mode, b.workspace, b.sessionId, b.mark,
      JSON.stringify(b.abilities), JSON.stringify(b.grants), b.autoPlan ? 1 : 0, b.confined ? 1 : 0, b.origin, b.branch, b.createdAt,
    );
  }

  saveBee(b: BeeRow): void {
    this.run(
      `UPDATE bees SET space_id = ?, name = ?, kind = ?, role = ?, model = ?, effort = ?, mode = ?, workspace = ?,
       session_id = ?, abilities = ?, grants = ?, auto_plan = ?, confined = ?, origin = ?, branch = ? WHERE id = ?`,
      b.spaceId, b.name, b.kind, b.role, b.model, b.effort, b.mode, b.workspace, b.sessionId,
      JSON.stringify(b.abilities), JSON.stringify(b.grants), b.autoPlan ? 1 : 0, b.confined ? 1 : 0, b.origin, b.branch, b.id,
    );
  }

  removeBee(id: string): void {
    this.run('UPDATE bees SET removed = 1 WHERE id = ?', id);
  }

  // Events

  addEvent(beeId: string, kind: EventKind, data: Record<string, unknown>): EventRow {
    const ts = Date.now();
    const id = this.run(
      'INSERT INTO events (bee_id, ts, kind, data) VALUES (?, ?, ?, ?)',
      beeId, ts, kind, JSON.stringify(data),
    );
    return { id, beeId, ts, kind, data };
  }

  /** Newest events first in the query, returned oldest first. */
  events(beeId: string, before = Number.MAX_SAFE_INTEGER, limit = 200): EventRow[] {
    return this.all(
      'SELECT * FROM events WHERE bee_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
      beeId, before, Math.min(limit, 500),
    )
      .map(toEvent)
      .reverse();
  }

  /** Tokens per bee and day, from the turns in the history. */
  usage(sinceTs: number): { beeId: string; day: string; tokensIn: number; tokensOut: number; turns: number }[] {
    return this.all(
      `SELECT bee_id, date(ts / 1000, 'unixepoch', 'localtime') AS day, count(*) AS turns,
       sum(json_extract(data, '$.tokensIn')) AS tin, sum(json_extract(data, '$.tokensOut')) AS tout
       FROM events WHERE kind = 'turn' AND ts >= ? GROUP BY bee_id, day ORDER BY day`,
      sinceTs,
    ).map((r) => ({
      beeId: r.bee_id as string,
      day: r.day as string,
      turns: r.turns as number,
      tokensIn: (r.tin as number) ?? 0,
      tokensOut: (r.tout as number) ?? 0,
    }));
  }

  // Orders

  addOrder(
    o: Pick<OrderRow, 'beeId' | 'source' | 'text' | 'priority'> & Partial<Pick<OrderRow, 'taskId' | 'planId' | 'planFirst'>>,
  ): OrderRow {
    const id = this.run(
      `INSERT INTO orders (bee_id, source, text, priority, status, task_id, plan_id, plan_first, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
      o.beeId, o.source, o.text, o.priority, o.taskId ?? null, o.planId ?? null, o.planFirst ? 1 : 0, Date.now(),
    );
    return this.order(id)!;
  }

  order(id: number): OrderRow | null {
    const row = this.one('SELECT * FROM orders WHERE id = ?', id);
    return row ? toOrder(row) : null;
  }

  openOrders(): OrderRow[] {
    return this.all(
      "SELECT * FROM orders WHERE status IN ('queued', 'running') ORDER BY priority DESC, id",
    ).map(toOrder);
  }

  recentOrders(limit = 50): OrderRow[] {
    return this.all('SELECT * FROM orders ORDER BY id DESC LIMIT ?', limit).map(toOrder);
  }

  setOrder(id: number, status: OrderStatus): OrderRow {
    const now = Date.now();
    if (status === 'running') this.run('UPDATE orders SET status = ?, started_at = ? WHERE id = ?', status, now, id);
    else if (status === 'queued') this.run('UPDATE orders SET status = ?, started_at = NULL WHERE id = ?', status, id);
    else this.run('UPDATE orders SET status = ?, ended_at = ? WHERE id = ?', status, now, id);
    return this.order(id)!;
  }

  // Approvals

  addApproval(beeId: string, tool: string, input: Record<string, unknown>, reason: string): ApprovalRow {
    const id = this.run(
      "INSERT INTO approvals (bee_id, tool, input, reason, status, created_at) VALUES (?, ?, ?, ?, 'waiting', ?)",
      beeId, tool, JSON.stringify(input), reason, Date.now(),
    );
    return this.approval(id)!;
  }

  approval(id: number): ApprovalRow | null {
    const row = this.one('SELECT * FROM approvals WHERE id = ?', id);
    return row ? toApproval(row) : null;
  }

  waitingApprovals(): ApprovalRow[] {
    return this.all("SELECT * FROM approvals WHERE status = 'waiting' ORDER BY id").map(toApproval);
  }

  setApproval(id: number, status: ApprovalStatus): ApprovalRow {
    this.run('UPDATE approvals SET status = ?, decided_at = ? WHERE id = ?', status, Date.now(), id);
    return this.approval(id)!;
  }

  // Plans and tasks

  addPlan(p: Pick<PlanRow, 'spaceId' | 'queenId' | 'goal' | 'limits'>): PlanRow {
    const id = this.run(
      `INSERT INTO plans (space_id, queen_id, goal, status, limits, used, created_at)
       VALUES (?, ?, ?, 'proposed', ?, ?, ?)`,
      p.spaceId, p.queenId, p.goal, JSON.stringify(p.limits),
      JSON.stringify({ orders: 0, wakeups: 0, tokens: 0 }), Date.now(),
    );
    return this.plan(id)!;
  }

  plan(id: number): PlanRow | null {
    const row = this.one('SELECT * FROM plans WHERE id = ?', id);
    return row ? toPlan(row) : null;
  }

  /** Open plans, plus the most recent finished ones. */
  plans(limit = 30): PlanRow[] {
    return this.all(
      `SELECT * FROM plans WHERE status IN ('proposed', 'running')
       UNION SELECT * FROM (SELECT * FROM plans ORDER BY id DESC LIMIT ?) ORDER BY id`,
      limit,
    ).map(toPlan);
  }

  savePlan(p: PlanRow): void {
    this.run(
      'UPDATE plans SET goal = ?, status = ?, limits = ?, used = ?, started_at = ?, ended_at = ? WHERE id = ?',
      p.goal, p.status, JSON.stringify(p.limits), JSON.stringify(p.used), p.startedAt, p.endedAt, p.id,
    );
  }

  addTask(t: Pick<TaskRow, 'planId' | 'key' | 'title' | 'brief' | 'beeId' | 'deps' | 'files' | 'status'>): TaskRow {
    const id = this.run(
      `INSERT INTO tasks (plan_id, key, title, brief, bee_id, deps, files, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      t.planId, t.key, t.title, t.brief, t.beeId, JSON.stringify(t.deps), JSON.stringify(t.files), t.status, Date.now(),
    );
    return this.task(id)!;
  }

  task(id: number): TaskRow | null {
    const row = this.one('SELECT * FROM tasks WHERE id = ?', id);
    return row ? toTask(row) : null;
  }

  tasks(planId: number): TaskRow[] {
    return this.all('SELECT * FROM tasks WHERE plan_id = ? ORDER BY id', planId).map(toTask);
  }

  saveTask(t: TaskRow): void {
    this.run(
      'UPDATE tasks SET title = ?, brief = ?, bee_id = ?, status = ?, order_id = ?, report = ?, score = ?, ended_at = ? WHERE id = ?',
      t.title, t.brief, t.beeId, t.status, t.orderId, t.report, t.score, t.endedAt, t.id,
    );
  }

  // Board, links, messages

  addBoard(spaceId: string, author: string, topic: string, text: string): BoardRow {
    const id = this.run(
      'INSERT INTO board (space_id, author, topic, text, ts) VALUES (?, ?, ?, ?, ?)',
      spaceId, author, topic, text, Date.now(),
    );
    return toBoard(this.one('SELECT * FROM board WHERE id = ?', id)!);
  }

  board(spaceId?: string, limit = 200): BoardRow[] {
    const rows = spaceId
      ? this.all('SELECT * FROM board WHERE space_id = ? ORDER BY id DESC LIMIT ?', spaceId, limit)
      : this.all('SELECT * FROM board ORDER BY id DESC LIMIT ?', limit);
    return rows.map(toBoard).reverse();
  }

  removeBoard(id: number): void {
    this.run('DELETE FROM board WHERE id = ?', id);
  }

  links(): LinkRow[] {
    return this.all('SELECT * FROM links').map(toLink);
  }

  link(from: string, to: string): LinkRow {
    const row = this.one('SELECT * FROM links WHERE from_id = ? AND to_id = ?', from, to);
    return row ? toLink(row) : { from, to, weight: 0.5, uses: 0 };
  }

  saveLink(l: LinkRow): void {
    this.run(
      `INSERT INTO links (from_id, to_id, weight, uses) VALUES (?, ?, ?, ?)
       ON CONFLICT (from_id, to_id) DO UPDATE SET weight = excluded.weight, uses = excluded.uses`,
      l.from, l.to, l.weight, l.uses,
    );
  }

  addMessage(from: string, to: string, text: string): MessageRow {
    const id = this.run('INSERT INTO messages (from_id, to_id, text, ts) VALUES (?, ?, ?, ?)', from, to, text, Date.now());
    return toMessage(this.one('SELECT * FROM messages WHERE id = ?', id)!);
  }

  undelivered(to: string): MessageRow[] {
    return this.all('SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY id', to).map(toMessage);
  }

  deliver(ids: number[], orderId: number): void {
    for (const id of ids) this.run('UPDATE messages SET delivered = 1, order_id = ? WHERE id = ?', orderId, id);
  }

  messagesFor(orderId: number): MessageRow[] {
    return this.all('SELECT * FROM messages WHERE order_id = ?', orderId).map(toMessage);
  }

  // Notices

  addNotice(n: Pick<NoticeRow, 'spaceId' | 'kind' | 'source' | 'title' | 'body'>): NoticeRow {
    const id = this.run(
      'INSERT INTO notices (space_id, kind, source, title, body, ts) VALUES (?, ?, ?, ?, ?, ?)',
      n.spaceId, n.kind, n.source, n.title, n.body, Date.now(),
    );
    return toNotice(this.one('SELECT * FROM notices WHERE id = ?', id)!);
  }

  notices(limit = 100): NoticeRow[] {
    return this.all('SELECT * FROM notices ORDER BY id DESC LIMIT ?', limit).map(toNotice);
  }

  readNotices(which: { id?: number; source?: string }): void {
    if (which.id !== undefined) this.run('UPDATE notices SET read = 1 WHERE id = ?', which.id);
    else if (which.source !== undefined) this.run('UPDATE notices SET read = 1 WHERE source = ?', which.source);
    else this.run('UPDATE notices SET read = 1');
  }

  // Automations

  automations(): AutomationRow[] {
    return this.all('SELECT * FROM automations ORDER BY id').map(toAutomation);
  }

  saveAutomation(a: Omit<AutomationRow, 'id'> & { id?: number }): AutomationRow {
    const rule = JSON.stringify({ when: a.when, then: a.then });
    let id = a.id;
    if (id === undefined) {
      id = this.run(
        'INSERT INTO automations (space_id, name, enabled, rule, last_run) VALUES (?, ?, ?, ?, ?)',
        a.spaceId, a.name, a.enabled ? 1 : 0, rule, a.lastRun,
      );
    } else {
      this.run(
        'UPDATE automations SET name = ?, enabled = ?, rule = ?, last_run = ? WHERE id = ?',
        a.name, a.enabled ? 1 : 0, rule, a.lastRun, id,
      );
    }
    return toAutomation(this.one('SELECT * FROM automations WHERE id = ?', id)!);
  }

  removeAutomation(id: number): void {
    this.run('DELETE FROM automations WHERE id = ?', id);
  }

  // Terminals that should come back

  terms(): SavedTerm[] {
    return this.all('SELECT * FROM terms ORDER BY created_at').map((r) => ({
      id: r.id as string,
      spaceId: r.space_id as string,
      kind: r.kind as SavedTerm['kind'],
      cwd: r.cwd as string,
      host: (r.host as string | null) ?? null,
      sessionId: r.session_id as string | null,
      screen: r.screen as string,
      cols: r.cols as number,
      rows: r.rows as number,
    }));
  }

  saveTerm(t: SavedTerm): void {
    this.run(
      `INSERT INTO terms (id, space_id, kind, cwd, host, session_id, screen, cols, rows, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET cwd = excluded.cwd, session_id = excluded.session_id, screen = excluded.screen,
       cols = excluded.cols, rows = excluded.rows, space_id = excluded.space_id`,
      t.id, t.spaceId, t.kind, t.cwd, t.host, t.sessionId, t.screen, t.cols, t.rows, Date.now(),
    );
  }

  removeTerm(id: string): void {
    this.run('DELETE FROM terms WHERE id = ?', id);
  }

  // Small settings (layouts and similar)

  get(key: string): unknown {
    const row = this.one('SELECT value FROM kv WHERE key = ?', key);
    return row ? json(row.value) : null;
  }

  set(key: string, value: unknown): void {
    this.run(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key, JSON.stringify(value ?? null),
    );
  }

  unset(key: string): void {
    this.run('DELETE FROM kv WHERE key = ?', key);
  }

  withPrefix(prefix: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const r of this.all('SELECT * FROM kv WHERE substr(key, 1, ?) = ?', prefix.length, prefix)) {
      out[(r.key as string).slice(prefix.length)] = json(r.value);
    }
    return out;
  }
}
