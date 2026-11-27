import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { bringCopy, type Copy, copyState, type CopyState, dropUnused, makeCopy } from './copies.ts';
import type { Answer, ContextUse, Driver, HiveTools, StartDriver } from './driver.ts';
import { normalize, typingDelta } from './normalize.ts';
import { prepareWorkspace } from './paths.ts';
import { grantFor, judge, type Situation, type Verdict, withSite } from './policy.ts';
import type { Store } from './store.ts';
import { type Agent,
  type ApprovalRow,
  type BeeRow,
  type BeeStatus,
  type BeeView,
  EFFORTS,
  type EventKind,
  type Grant,
  MODELS,
  NO_ABILITIES,
  type OrderRow,
  PRIORITY,
} from './types.ts';

interface Running {
  row: BeeRow;
  status: BeeStatus;
  detail: string | null;
  driver: Driver | null;
  /** Bumped whenever the driver is replaced, so a dying process cannot speak for a new one. */
  epoch: number;
  order: OrderRow | null;
  /** The last thing said during the current order; its report if no better one is given. */
  said: string;
  tokens: number;
  stopAsked: boolean;
  /** Its folder is being prepared; orders wait. */
  held: boolean;
  retried: boolean;
  approvals: Set<number>;
  idleTimer: NodeJS.Timeout | null;
}

export interface HiveOptions {
  store: Store;
  start: StartDriver;
  maxRunning?: number;
  /** How long an unused bee keeps its process before it is put to sleep. */
  idleMs?: number;
  /** How long a bee has to obey a stop before its process is ended. */
  stopMs?: number;
  /** Why no new order may start right now, or null. */
  gate?: () => string | null;
}

export type BeeFields = Pick<
  BeeRow,
  'agent' | 'name' | 'kind' | 'role' | 'model' | 'effort' | 'mode' | 'workspace' | 'abilities' | 'grants' | 'autoPlan' | 'spaceId' | 'confined'
>;
export type NewBee = Pick<BeeFields, 'name' | 'workspace'> & Partial<Omit<BeeFields, 'name' | 'workspace'>>;

/** A git copy made for a bee that is about to use it. */
interface Given extends Copy {
  id: string;
  origin: string;
}

export interface OrderOptions {
  now?: boolean;
  source?: string;
  planFirst?: boolean;
  taskId?: number;
  planId?: number;
}

const newId = () => randomUUID().slice(0, 8);

/** How an order ended, for the rest of the hive. */
export interface Finished {
  order: OrderRow;
  bee: BeeRow;
  status: 'done' | 'failed' | 'stopped';
  said: string;
  detail: string | null;
  tokens: number;
}

/** What the rest of the hive adds to a bee's work. */
export interface Team {
  tools(beeId: string): HiveTools;
  situation(bee: BeeRow, order: OrderRow | null): Situation;
  /** Text put in front of an order, such as messages from other bees. */
  preamble(bee: BeeRow, order: OrderRow): string;
}

const ALONE: Team = { tools: () => [], situation: () => ({}), preamble: () => '' };

/**
 * Picks the next order to start: highest priority first, then oldest, skipping
 * bees that are already working.
 */
export function pickNext(orders: OrderRow[], busyBees: Set<string>): OrderRow | null {
  let best: OrderRow | null = null;
  for (const o of orders) {
    if (o.status !== 'queued' || busyBees.has(o.beeId)) continue;
    if (!best || o.priority > best.priority || (o.priority === best.priority && o.id < best.id)) best = o;
  }
  return best;
}

/**
 * Owns every bee. Emits 'push' with messages for open windows, 'finished' when an
 * order ends and 'asked' when a bee needs the person.
 */
export class Hive extends EventEmitter {
  team: Team = ALONE;
  private bees = new Map<string, Running>();
  private answers = new Map<number, (a: Answer) => void>();
  private store: Store;
  private start: StartDriver;
  private maxRunning: number;
  private idleMs: number;
  private stopMs: number;
  private gate: () => string | null;
  private lastLimit = 'allowed';

  constructor(opts: HiveOptions) {
    super();
    this.store = opts.store;
    this.start = opts.start;
    this.maxRunning = Math.min(opts.maxRunning ?? 4, 8);
    this.idleMs = opts.idleMs ?? 10 * 60_000;
    this.stopMs = opts.stopMs ?? 10_000;
    this.gate = opts.gate ?? (() => null);

    for (const row of this.store.bees()) this.bees.set(row.id, fresh(row));
  }

  /**
   * After a crash or restart nothing is really running, so say so in the history.
   * Call once, and only when no other Beekeep server can be using the same data.
   */
  recover(): void {
    for (const o of this.store.openOrders()) {
      if (o.status !== 'running') continue;
      this.store.setOrder(o.id, 'stopped');
      this.store.addEvent(o.beeId, 'note', { text: 'Beekeep restarted while this order was running, so it was stopped.' });
    }
    for (const a of this.store.waitingApprovals()) {
      this.store.setApproval(a.id, 'expired');
      this.store.addEvent(a.beeId, 'decision', { approvalId: a.id, decision: 'expired' });
    }
  }

  // Reading

  views(): BeeView[] {
    return [...this.bees.values()].map((b) => view(b));
  }

  view(id: string): BeeView {
    return view(this.bee(id));
  }

  private bee(id: string): Running {
    const b = this.bees.get(id);
    if (!b) throw new Error('No such bee.');
    return b;
  }

  // Bees

  /** The same as createBee or updateBee, in a git copy of its own. Takes as long as git needs. */
  async withCopy(input: NewBee): Promise<BeeView>;
  async withCopy(input: Partial<BeeFields>, id: string): Promise<BeeView>;
  async withCopy(input: Partial<BeeFields>, id?: string): Promise<BeeView> {
    const old = id ? this.bee(id) : null;
    if (old?.order) throw new Error('Stop the bee before changing it.');
    if (old?.row.origin) return this.updateBee(id!, input);
    const name = this.checkName(input.name ?? old!.row.name, id);
    const origin = prepareWorkspace(input.workspace ?? old!.row.workspace);
    const beeId = id ?? newId();
    if (old?.held) throw new Error('A copy for this bee is being made already.');
    // Orders meant for the copy must not run in the shared folder meanwhile.
    if (old) old.held = true;
    try {
      const given = { id: beeId, origin, ...(await makeCopy(origin, name, beeId)) };
      try {
        return id ? this.updateBee(id, input, given) : this.createBee(input as NewBee, given);
      } catch (err) {
        dropUnused(given.root);
        throw err;
      }
    } finally {
      if (old) old.held = false;
      this.pump();
    }
  }

  createBee(input: NewBee, given?: Given): BeeView {
    const agent = input.agent ?? 'claude';
    const row: BeeRow = {
      id: given?.id ?? newId(),
      agent,
      spaceId: input.spaceId ?? 'main',
      name: this.checkName(input.name),
      kind: checkKind(agent, input.kind ?? 'worker'),
      role: input.role?.trim() ?? '',
      model: checkModel(agent, input.model ?? (agent === 'codex' ? 'default' : input.kind === 'queen' ? 'sonnet' : 'haiku')),
      effort: checkEffort(input.effort ?? null),
      mode: checkMode(input.mode ?? 'look'),
      workspace: prepareWorkspace(input.workspace),
      sessionId: null,
      mark: this.store.beeCount() % 5,
      abilities: { ...NO_ABILITIES, ...input.abilities },
      grants: [],
      autoPlan: input.autoPlan ?? false,
      confined: input.confined ?? true,
      origin: null,
      branch: null,
      createdAt: Date.now(),
    };
    if (given) this.useCopy(row, given);
    this.store.addBee(row);
    const b = fresh(row);
    this.bees.set(row.id, b);
    this.pushBees();
    return view(b);
  }

  updateBee(id: string, change: Partial<BeeFields>, given?: Given): BeeView {
    const b = this.bee(id);
    if (b.order) throw new Error('Stop the bee before changing it.');
    const next = { ...b.row };
    if (change.name !== undefined) next.name = this.checkName(change.name, id);
    if (change.agent !== undefined && change.agent !== next.agent) {
      next.agent = change.agent;
      next.model = change.agent === 'codex' ? 'default' : 'haiku';
      next.sessionId = null; // One agent cannot pick up another's conversation.
    }
    if (change.kind !== undefined) next.kind = change.kind;
    next.kind = checkKind(next.agent, next.kind);
    if (change.role !== undefined) next.role = change.role.trim();
    if (change.model !== undefined) next.model = checkModel(next.agent, change.model);
    if (change.effort !== undefined) next.effort = checkEffort(change.effort);
    if (change.mode !== undefined) next.mode = checkMode(change.mode);
    if (change.confined !== undefined) next.confined = change.confined;
    // A bee with its own copy stays in it; its folder changes only by giving the copy up.
    if (change.workspace !== undefined && !next.origin) next.workspace = prepareWorkspace(change.workspace);
    if (given) this.useCopy(next, given);
    if (change.abilities !== undefined) next.abilities = { ...NO_ABILITIES, ...change.abilities };
    if (change.autoPlan !== undefined) next.autoPlan = change.autoPlan;
    if (change.spaceId !== undefined) next.spaceId = change.spaceId;
    // Standing permissions come only from answering a request; here they can only be taken away.
    if (change.grants !== undefined) {
      const keep = new Set(change.grants.map((g) => JSON.stringify([g.tool, g.match])));
      next.grants = next.grants.filter((g) => keep.has(JSON.stringify([g.tool, g.match])));
    }
    // Saved conversations belong to a folder, so a new folder means a new memory.
    if (next.workspace !== b.row.workspace && next.sessionId) {
      next.sessionId = null;
      this.record(id, 'note', { text: 'Workspace changed: this bee starts with a fresh memory.' });
    }
    this.replace(b, next);
    this.sleep(b); // Takes effect on the next order.
    return view(b);
  }

  private useCopy(row: BeeRow, given: Given): void {
    if (row.origin) throw new Error('This bee has a copy of its own already.');
    this.store.set(`copy:${row.id}`, given.base);
    Object.assign(row, { workspace: given.path, origin: given.origin, branch: given.branch });
  }

  /** The bee goes back to the folder its copy was made of. The copy stays. */
  leaveCopy(id: string): void {
    const b = this.bee(id);
    if (b.order) throw new Error('Stop the bee before changing it.');
    if (!b.row.origin) return;
    this.record(id, 'note', { text: `Its own copy stays at ${b.row.workspace}. Delete it yourself when you do not need it.` });
    this.replace(b, { ...b.row, workspace: b.row.origin, origin: null, branch: null, sessionId: null });
    this.sleep(b);
    this.pushBees();
  }

  /** How far a bee's own copy is from the person's folder. */
  async copy(id: string): Promise<CopyState | null> {
    const { row } = this.bee(id);
    const base = this.store.get(`copy:${id}`);
    return row.origin && row.branch && typeof base === 'string' ? copyState(row.workspace, row.origin, row.branch, base) : null;
  }

  /** Brings the bee's commits into the person's repository as a branch. Returns how many. */
  async bring(id: string): Promise<string> {
    const { row } = this.bee(id);
    const base = this.store.get(`copy:${id}`);
    if (!row.origin || !row.branch || typeof base !== 'string') throw new Error('This bee has no copy of its own.');
    return bringCopy(row.workspace, row.origin, row.branch, base);
  }

  private checkName(raw: string, self?: string): string {
    const name = raw.trim();
    if (!name) throw new Error('Give the bee a name.');
    if (this.views().some((o) => o.id !== self && o.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`There is already a bee called ${name}.`);
    }
    return name;
  }

  private replace(b: Running, row: BeeRow): void {
    b.row = row;
    this.store.saveBee(row);
  }

  /** Returns where its git copy was kept, if it was. */
  removeBee(id: string): string | null {
    const b = this.bee(id);
    if (b.order) throw new Error('Stop the bee before removing it.');
    const dropped = this.store.openOrders().filter((o) => o.beeId === id);
    for (const o of dropped) this.store.setOrder(o.id, 'cancelled');
    this.sleep(b);
    this.store.removeBee(id);
    this.bees.delete(id);
    this.pushBees();
    this.pushOrders();
    for (const o of dropped) this.tell('cancelled', o);
    this.tell('removed', id);
    return b.row.origin ? `Its own copy stays at ${b.row.workspace}. Delete it yourself when you do not need it.` : null;
  }

  /** Forget the conversation so far. The history in the window stays. */
  forget(id: string): void {
    const b = this.bee(id);
    if (b.order) throw new Error('Stop the bee first.');
    this.sleep(b);
    this.replace(b, { ...b.row, sessionId: null });
    this.record(id, 'note', { text: 'You cleared this bee’s memory. It starts fresh with the next order.' });
    this.pushBees();
  }

  /** What fills the bee's memory, or null while it sleeps. */
  async context(id: string): Promise<ContextUse | null> {
    return (await this.bee(id).driver?.context?.()) ?? null;
  }

  /** Put files back as they were before one of the bee's orders. */
  async undo(id: string, uuid: string): Promise<string[]> {
    const b = this.bee(id);
    if (b.order) throw new Error('Stop the bee before undoing its work.');
    if (!b.driver) await this.wake(b);
    const done = await b.driver!.undo?.(uuid);
    if (!done?.ok) throw new Error(done?.why ?? 'Nothing to undo for this order.');
    this.record(id, 'note', { text: `You undid the file changes of an order: ${done.files.join(', ') || 'no files'}.` });
    return done.files;
  }

  // Orders

  /** Queue an order. With `now`, the bee drops what it is doing and does this first. */
  order(beeId: string, text: string, opts: OrderOptions = {}): OrderRow {
    const b = this.bee(beeId);
    const body = text.trim();
    if (!body) throw new Error('The order is empty.');
    const source = opts.source ?? 'you';
    const priority = source !== 'you' ? PRIORITY.bee : opts.now ? PRIORITY.now : PRIORITY.you;
    const order = this.store.addOrder({
      beeId,
      source,
      text: body,
      priority,
      planFirst: opts.planFirst,
      taskId: opts.taskId,
      planId: opts.planId,
    });
    this.pushOrders();
    if (opts.now && source === 'you' && b.order) this.stop(beeId);
    this.pump();
    return order;
  }

  cancelOrder(id: number): void {
    const o = this.store.order(id);
    if (!o || o.status !== 'queued') throw new Error('That order is no longer waiting.');
    this.store.setOrder(id, 'cancelled');
    this.pushOrders();
    this.tell('cancelled', o);
  }

  /** Start orders left waiting by a restart, a pause or a usage limit. */
  resume(): void {
    this.pump();
  }

  /** Stop what the bee is doing right now. Its waiting orders stay queued. */
  stop(beeId: string): void {
    const b = this.bee(beeId);
    if (!b.order || b.stopAsked) return;
    b.stopAsked = true;
    this.setStatus(b, 'stopping');
    for (const id of b.approvals) this.settle(id, 'denied', 'The keeper stopped this bee.');
    const { driver, epoch } = b;
    const orderId = b.order.id;
    if (!driver) return; // Still starting: begin() sees stopAsked and gives up.

    // A bee that does not take the stop request has its process ended instead.
    const force = (why: string) => {
      if (b.epoch !== epoch || b.order?.id !== orderId) return;
      this.record(beeId, 'note', { text: `${why} Ending the bee's process; its memory is kept.` });
      this.sleep(b);
      this.finish(b, 'stopped');
    };
    driver.interrupt().catch((err: Error) => force(`Stop request failed: ${err.message}.`));
    setTimeout(() => force('No answer to the stop request.'), this.stopMs).unref();
  }

  stopAll(): void {
    for (const b of this.bees.values()) if (b.order) this.stop(b.row.id);
  }

  // Approvals

  decide(
    id: number,
    allow: boolean,
    opts: { always?: boolean; answers?: Record<string, string>; note?: string } = {},
  ): void {
    const a = this.store.approval(id);
    if (!a || a.status !== 'waiting') throw new Error('That request is no longer waiting.');
    if (allow && opts.always) {
      const grant = grantFor(a.tool, a.input);
      const b = this.bees.get(a.beeId);
      if (!grant || !b) throw new Error('This can only be allowed once.');
      this.grant(b, grant);
    }
    const note = opts.note?.trim();
    this.settle(
      id,
      allow ? 'allowed' : 'denied',
      note ? `The keeper refused this action and says: ${note}` : 'The keeper refused this action.',
      opts.answers,
    );
  }

  private grant(b: Running, grant: Grant): void {
    this.replace(b, { ...b.row, grants: [...b.row.grants, grant] });
    this.record(b.row.id, 'note', {
      text: `You allowed this from now on: ${grant.tool}${grant.match ? ` ${grant.match}` : ''}. Take it back under Edit.`,
    });
    this.pushBees();
  }

  private settle(
    id: number,
    status: 'allowed' | 'denied' | 'expired',
    message: string,
    answers?: Record<string, string>,
  ): void {
    const answer = this.answers.get(id);
    const a = this.store.approval(id);
    if (!a || a.status !== 'waiting') return;
    this.answers.delete(id);
    this.store.setApproval(id, status);
    this.record(a.beeId, 'decision', { approvalId: id, decision: status, tool: a.tool, ...(answers ? { answers } : {}) });
    const b = this.bees.get(a.beeId);
    if (b) {
      b.approvals.delete(id);
      if (b.status === 'waiting' && b.approvals.size === 0) this.setStatus(b, 'busy');
    }
    this.pushApprovals();
    answer?.({ allow: status === 'allowed', message, answers });
  }

  private ask(b: Running, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<Answer> {
    if (b.stopAsked || signal.aborted) return Promise.resolve({ allow: false, message: 'The keeper stopped this bee.' });
    const verdict = this.judge(b, tool, input);
    const reason = verdict.kind === 'ask' ? verdict.reason : 'Needs your approval.';
    input = withSite(tool, input, this.team.situation(b.row, b.order));
    const a: ApprovalRow = this.store.addApproval(b.row.id, tool, input, reason);
    b.approvals.add(a.id);
    this.setStatus(b, 'waiting');
    this.record(b.row.id, 'approval', { approvalId: a.id, tool, input, reason });
    this.pushApprovals();
    signal.addEventListener('abort', () => this.settle(a.id, 'expired', 'The request was withdrawn.'), { once: true });
    const answer = new Promise<Answer>((resolve) => this.answers.set(a.id, resolve));
    this.tell('asked', { bee: b.row, approval: a });
    return answer;
  }

  private judge(b: Running, tool: string, input: Record<string, unknown>): Verdict {
    // Nothing is allowed once it was stopped, even if a step was already on its way.
    if (!b.order || b.stopAsked) return { kind: 'deny', reason: 'The keeper stopped this bee.' };
    return judge(b.row, tool, input, this.team.situation(b.row, b.order));
  }

  // Running

  private pump(): void {
    for (;;) {
      if (this.gate()) return;
      const busy = new Set([...this.bees.values()].filter((b) => b.order).map((b) => b.row.id));
      if (busy.size >= this.maxRunning) return;
      for (const b of this.bees.values()) if (b.held) busy.add(b.row.id);
      const next = pickNext(this.store.openOrders(), busy);
      if (!next) return;
      const b = this.bees.get(next.beeId);
      if (!b) {
        this.store.setOrder(next.id, 'cancelled');
        this.tell('cancelled', next);
        continue;
      }
      void this.begin(b, next);
    }
  }

  private async begin(b: Running, order: OrderRow): Promise<void> {
    // Claim the bee before the first await, so nothing else can start on it.
    b.order = this.store.setOrder(order.id, 'running');
    b.stopAsked = false;
    b.said = '';
    b.tokens = 0;
    if (b.idleTimer) clearTimeout(b.idleTimer);
    b.idleTimer = null;
    const uuid = randomUUID();
    const before = this.team.preamble(b.row, order);
    this.record(b.row.id, 'order', {
      orderId: order.id,
      source: order.source,
      text: order.text,
      uuid,
      ...(order.planFirst ? { planFirst: true } : {}),
      ...(order.taskId ? { taskId: order.taskId } : {}),
    });
    if (before) this.record(b.row.id, 'message', { text: before });
    this.setStatus(b, 'busy');
    this.pushOrders();

    try {
      if (!b.driver && !(await this.wake(b))) return;
      if (b.stopAsked) return this.finish(b, 'stopped');
      const sent = await b.driver!.send(before ? `${before}\n\n${order.text}` : order.text, {
        uuid,
        planFirst: order.planFirst,
        wanted: () => b.order?.id === order.id && !b.stopAsked,
      });
      if (sent === false && b.order?.id === order.id) this.finish(b, 'stopped');
    } catch (err) {
      if (b.order?.id !== order.id) return;
      this.record(b.row.id, 'error', { text: message(err) });
      this.finish(b, 'failed', message(err));
    }
  }

  /** Starts the bee's process. False if it was replaced meanwhile. */
  private async wake(b: Running): Promise<boolean> {
    const epoch = ++b.epoch;
    const driver = await this.start(b.row, {
      onMessage: (msg) => b.epoch === epoch && this.onMessage(b, msg),
      onExit: (err) => b.epoch === epoch && this.onExit(b, err),
      judge: (tool, input) => this.judge(b, tool, input),
      ask: (tool, input, signal) => this.ask(b, tool, input, signal),
      tools: () => this.team.tools(b.row.id),
    });
    if (b.epoch !== epoch) {
      driver.close();
      return false;
    }
    b.driver = driver;
    return true;
  }

  private onMessage(b: Running, msg: SDKMessage): void {
    const typing = typingDelta(msg);
    if (typing !== null) {
      this.emit('push', { ev: 'typing', beeId: b.row.id, text: typing });
      return;
    }
    for (const item of normalize(msg)) {
      if (item.kind === 'session') {
        const sessionId = item.data.sessionId as string;
        if (sessionId === b.row.sessionId) continue;
        this.replace(b, { ...b.row, sessionId });
      }
      if (item.kind === 'limit') {
        this.emit('limit', item.data);
        // Claude repeats this with every step; only a change is worth a line.
        const status = String(item.data.status);
        if (status === this.lastLimit) continue;
        this.lastLimit = status;
      }
      if (!b.order && item.kind === 'action') {
        this.record(b.row.id, 'note', { text: 'This bee is acting without an order. Ending its process.' });
        this.record(b.row.id, item.kind, item.data);
        this.sleep(b);
        return;
      }
      if (item.kind === 'say' && !item.data.helper) b.said = String(item.data.text);
      // A stopped turn reports internal error codes; what matters is that you stopped it.
      const stopped = item.kind === 'turn' && b.stopAsked;
      this.record(b.row.id, item.kind, stopped ? { ...item.data, ok: false, stopped: true, errors: [] } : item.data);
      if (item.kind === 'turn') {
        const ok = item.data.ok as boolean;
        const why = (item.data.errors as string[])[0] ?? null;
        b.tokens += Number(item.data.tokensIn) + Number(item.data.tokensOut);
        this.finish(b, b.stopAsked ? 'stopped' : ok ? 'done' : 'failed', ok || b.stopAsked ? null : why);
      }
    }
  }

  private onExit(b: Running, err: Error | null): void {
    b.driver = null;
    b.epoch += 1;
    const text = err ? err.message : 'The bee’s process ended.';
    const { order } = b;
    if (!order) {
      this.setStatus(b, 'off');
      return;
    }
    const memoryLost = /no conversation found/i.test(text) && b.row.sessionId !== null;
    if (memoryLost && !b.retried && !b.stopAsked) {
      b.retried = true;
      this.replace(b, { ...b.row, sessionId: null });
      this.record(b.row.id, 'note', { text: 'Saved memory could not be found. Starting this bee fresh.' });
      this.expireApprovals(b);
      b.order = null;
      this.store.setOrder(order.id, 'queued');
      this.pump();
      return;
    }
    this.record(b.row.id, b.stopAsked ? 'note' : 'error', { text });
    this.finish(b, b.stopAsked ? 'stopped' : 'failed', b.stopAsked ? null : text);
  }

  private finish(b: Running, status: 'done' | 'failed' | 'stopped', detail: string | null = null): void {
    if (!b.order) return;
    const order = this.store.setOrder(b.order.id, status);
    const ended: Finished = { order, bee: b.row, status, said: b.said, detail, tokens: b.tokens };
    b.order = null;
    b.stopAsked = false;
    b.retried = false;
    this.expireApprovals(b);
    this.setStatus(b, status === 'failed' ? 'error' : b.driver ? 'idle' : 'off', detail);
    this.pushOrders();
    if (b.driver) {
      b.idleTimer = setTimeout(() => !b.order && this.sleep(b), this.idleMs);
      b.idleTimer.unref();
    }
    this.tell('finished', ended);
    this.pump();
  }

  private expireApprovals(b: Running): void {
    for (const id of b.approvals) this.settle(id, 'expired', 'The order ended.');
  }

  /** Ends the bee's process. Its memory is on disk and comes back with the next order. */
  private sleep(b: Running): void {
    if (b.idleTimer) clearTimeout(b.idleTimer);
    b.idleTimer = null;
    b.epoch += 1;
    b.driver?.close();
    b.driver = null;
    if (!b.order) this.setStatus(b, 'off');
  }

  shutdown(): void {
    for (const b of this.bees.values()) {
      this.expireApprovals(b);
      b.epoch += 1;
      b.driver?.close();
      b.driver = null;
      if (b.idleTimer) clearTimeout(b.idleTimer);
    }
  }

  /** Tells the other parts. A mistake in one of them must not break the bees. */
  private tell(what: string, data: unknown): void {
    try {
      this.emit(what, data);
    } catch (err) {
      console.error(`Beekeep: handling "${what}" failed.`, err);
    }
  }

  // Telling open windows

  /** Adds a line to a bee's history and shows it. */
  record(beeId: string, kind: EventKind, data: Record<string, unknown>): void {
    this.emit('push', { ev: 'event', event: this.store.addEvent(beeId, kind, data) });
  }

  private setStatus(b: Running, status: BeeStatus, detail: string | null = null): void {
    b.status = status;
    b.detail = detail;
    this.pushBees();
  }

  private pushBees(): void {
    this.emit('push', { ev: 'bees', bees: this.views() });
  }

  pushOrders(): void {
    this.emit('push', { ev: 'orders', orders: this.store.openOrders() });
  }

  private pushApprovals(): void {
    this.emit('push', { ev: 'approvals', approvals: this.store.waitingApprovals() });
  }
}

function fresh(row: BeeRow): Running {
  return {
    row,
    status: 'off',
    detail: null,
    driver: null,
    epoch: 0,
    order: null,
    said: '',
    tokens: 0,
    stopAsked: false,
    held: false,
    retried: false,
    approvals: new Set(),
    idleTimer: null,
  };
}

function view(b: Running): BeeView {
  return { ...b.row, status: b.status, detail: b.detail, currentOrderId: b.order?.id ?? null };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function checkModel(agent: Agent, model: string): string {
  if (agent === 'codex') {
    if (!/^[\w.:-]{1,64}$/.test(model)) throw new Error(`Not a model name: ${model}`);
    return model;
  }
  if (!MODELS.some((m) => m.id === model)) throw new Error(`Unknown model: ${model}`);
  return model;
}

/** A queen plans through beekeep's team tools, which only Claude bees have for now. */
function checkKind(agent: Agent, kind: BeeRow['kind']): BeeRow['kind'] {
  if (kind === 'queen' && agent !== 'claude') throw new Error('A queen runs on Claude Code for now; Codex bees can be workers.');
  return kind;
}

function checkEffort(effort: string | null): string | null {
  if (effort !== null && !EFFORTS.includes(effort)) throw new Error(`Unknown effort: ${effort}`);
  return effort;
}

function checkMode(mode: string): BeeRow['mode'] {
  if (mode !== 'look' && mode !== 'work' && mode !== 'full') throw new Error(`Unknown mode: ${mode}`);
  return mode;
}

