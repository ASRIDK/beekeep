import { homedir } from 'node:os';
import { z } from 'zod';
import type { Automations } from './automations.ts';
import type { BrowserInput, Browsers } from './browser.ts';
import type { Commands } from './commands.ts';
import type { Guard } from './guard.ts';
import type { Hive } from './hive.ts';
import type { Notices } from './notices.ts';
import { listMcp, listSkills } from './outside.ts';
import { defaultWorkspace } from './paths.ts';
import type { Spaces } from './spaces.ts';
import type { Store } from './store.ts';
import type { Team } from './team.ts';
import type { Terms } from './terms.ts';
import { EFFORTS, MODELS, type Snapshot } from './types.ts';

export interface Context {
  hive: Hive;
  team: Team;
  store: Store;
  terms: Terms;
  guard: Guard;
  notices: Notices;
  spaces: Spaces;
  browsers: Browsers;
  automations: Automations;
  commands: Commands;
  /** Windows connected right now. */
  windows?: () => number;
}

/** What one connected window may ask for. */
export interface Session {
  /** Terminals and browser pages this window is watching. */
  watching: Set<string>;
  focused: boolean;
}

const text = z.string().max(50_000);
const id = z.string().min(1).max(64);
const num = z.number().int().positive();
const size = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };
const names = z.array(z.string().max(100)).max(100);

const beeFields = {
  name: z.string().max(40),
  kind: z.enum(['worker', 'queen']),
  role: text,
  model: id,
  effort: z.string().nullable(),
  mode: z.enum(['look', 'work', 'full']),
  workspace: z.string().max(1000),
  abilities: z.object({
    mcp: names,
    skills: names,
    project: z.boolean(),
    helpers: z.boolean(),
    questions: z.boolean(),
    browser: z.boolean(),
    shell: z.boolean(),
  }),
  grants: z.array(z.object({ tool: z.string(), match: z.string().optional() })).max(500),
  autoPlan: z.boolean(),
  confined: z.boolean(),
  ownCopy: z.boolean(),
  spaceId: id,
};

const pos = z.number().min(0).max(10_000);
const browserInput = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved']),
    x: pos,
    y: pos,
    button: z.enum(['left', 'right', 'none']),
    clicks: z.number().int().min(0).max(3),
  }),
  z.object({ kind: z.literal('wheel'), x: pos, y: pos, dx: z.number(), dy: z.number() }),
  z.object({ kind: z.literal('key'), key: z.string().max(30), down: z.boolean() }),
  z.object({ kind: z.literal('text'), text: z.string().max(10_000) }),
]);

const automation = z.object({
  id: num.optional(),
  spaceId: id,
  name: z.string().max(80),
  enabled: z.boolean(),
  when: z.discriminatedUnion('type', [
    z.object({ type: z.literal('finished'), beeId: id, status: z.enum(['done', 'failed', 'any']) }),
    z.object({ type: z.literal('every'), minutes: z.number().int().min(5).max(10_080) }),
    z.object({ type: z.literal('daily'), at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  ]),
  then: z.discriminatedUnion('type', [
    z.object({ type: z.literal('order'), beeId: id, text }),
    z.object({ type: z.literal('notice'), title: z.string().max(120) }),
  ]),
});

type Handler = (ctx: Context, args: unknown, session: Session) => unknown;

function op<S extends z.ZodType>(shape: S, run: (ctx: Context, args: z.infer<S>, session: Session) => unknown): Handler {
  return (ctx, args, session) => run(ctx, shape.parse(args ?? {}), session);
}

const ops: Record<string, Handler> = {
  snapshot: op(z.object({}), (c): Snapshot => {
    const plans = c.store.plans();
    return {
      bees: c.hive.views(),
      orders: c.store.openOrders(),
      approvals: c.store.waitingApprovals(),
      plans,
      tasks: plans.flatMap((p) => c.store.tasks(p.id)),
      board: c.store.board(),
      links: c.store.links(),
      notices: c.store.notices(),
      spaces: c.spaces.list(),
      spaceInfo: c.spaces.info(),
      terminals: c.terms.list(),
      browsers: c.browsers.list(),
      automations: c.automations.list(),
      guard: c.guard.get(),
      layouts: c.store.withPrefix('layout:'),
      currentSpace: c.spaces.current(),
      defaults: {
        workspace: defaultWorkspace(),
        home: homedir(),
        models: MODELS,
        efforts: EFFORTS,
        mcp: listMcp(),
        skills: listSkills(),
      },
    };
  }),
  focus: op(z.object({ on: z.boolean() }), ({ notices }, a, session) => {
    if (a.on !== session.focused) notices.watch(a.on ? 1 : -1);
    session.focused = a.on;
  }),

  // Spaces
  'space.create': op(z.object({ name: z.string().max(60), folder: z.string().max(1000) }), ({ spaces }, a) =>
    spaces.create(a.name, a.folder),
  ),
  'space.update': op(z.object({ id, name: z.string().max(60).optional(), folder: z.string().max(1000).optional() }), ({ spaces }, a) =>
    spaces.update(a.id, a),
  ),
  'space.remove': op(z.object({ id }), (c, a) => {
    const rest = c.spaces.list().find((s) => s.id !== a.id);
    if (!rest) throw new Error('This is the only space.');
    // Bees and terminals are never lost with a space; they move.
    for (const b of c.hive.views()) if (b.spaceId === a.id) c.hive.updateBee(b.id, { spaceId: rest.id });
    c.terms.moveAll(a.id, rest.id);
    c.spaces.remove(a.id);
  }),
  'space.current': op(z.object({ id }), ({ spaces }, a) => spaces.setCurrent(a.id)),
  'layout.save': op(z.object({ space: id, layout: z.unknown() }), ({ store }, a) => store.set(`layout:${a.space}`, a.layout)),

  // Bees
  'bee.create': op(
    z.object(beeFields).partial().required({ name: true, workspace: true }),
    ({ hive }, { ownCopy, ...a }) => (ownCopy ? hive.withCopy(a) : hive.createBee(a)),
  ),
  'bee.update': op(z.object(beeFields).partial().extend({ id }), ({ hive }, { id: beeId, ownCopy, ...change }) => {
    if (ownCopy) return hive.withCopy(change, beeId);
    const bee = hive.updateBee(beeId, change);
    if (ownCopy !== false || !bee.origin) return bee;
    hive.leaveCopy(beeId);
    return hive.view(beeId);
  }),
  'bee.remove': op(z.object({ id }), ({ hive }, a) => hive.removeBee(a.id)),
  'bee.stop': op(z.object({ id }), ({ hive }, a) => hive.stop(a.id)),
  'bee.forget': op(z.object({ id }), ({ hive }, a) => hive.forget(a.id)),
  'bee.copy': op(z.object({ id }), ({ hive }, a) => hive.copy(a.id)),
  'bee.bring': op(z.object({ id }), ({ hive }, a) => hive.bring(a.id)),
  'bee.context': op(z.object({ id }), ({ hive }, a) => hive.context(a.id)),
  'bee.undo': op(z.object({ id, uuid: id }), ({ hive }, a) => hive.undo(a.id, a.uuid)),
  stopAll: op(z.object({}), ({ hive }) => hive.stopAll()),

  // Orders. From a window they always come from the person; `source` cannot be set here.
  'order.send': op(z.object({ beeId: id, text, now: z.boolean().optional(), planFirst: z.boolean().optional() }), ({ hive }, a) =>
    hive.order(a.beeId, a.text, { now: a.now, planFirst: a.planFirst }),
  ),
  'order.cancel': op(z.object({ id: num }), ({ hive }, a) => hive.cancelOrder(a.id)),
  'order.feedback': op(z.object({ id: num, good: z.boolean() }), ({ team }, a) => team.feedback(a.id, a.good)),
  'queue.resume': op(z.object({}), ({ hive, team }) => {
    hive.resume();
    team.dispatch();
  }),
  'approval.decide': op(
    z.object({
      id: num,
      allow: z.boolean(),
      always: z.boolean().optional(),
      answers: z.record(z.string(), z.string()).optional(),
      note: z.string().max(2000).optional(),
    }),
    ({ hive }, a) => hive.decide(a.id, a.allow, a),
  ),

  // Plans, board, links
  'plan.approve': op(z.object({ id: num, upgrade: z.boolean().optional() }), ({ team }, a) => team.approve(a.id, a.upgrade)),
  'plan.refuse': op(z.object({ id: num, note: z.string().max(2000).optional() }), ({ team }, a) => team.refuse(a.id, a.note)),
  'plan.stop': op(z.object({ id: num }), ({ team }, a) => team.stopPlan(a.id, 'You stopped it.')),
  'plan.needs': op(z.object({ id: num }), ({ team }, a) => team.needs(a.id)),
  'task.stop': op(z.object({ planId: num, key: id }), ({ team }, a) => team.stopTask(a.planId, a.key)),
  'task.score': op(z.object({ id: num, score: z.number().min(0).max(1) }), ({ team, store }, a) => {
    const t = store.task(a.id);
    if (!t) throw new Error('No such task.');
    team.score(t, a.score, 'you');
  }),
  'board.post': op(z.object({ space: id, topic: z.string().max(60), text }), ({ team }, a) => team.post(a.space, 'you', a.topic, a.text)),
  'board.remove': op(z.object({ id: num }), ({ store, team }, a) => {
    store.removeBoard(a.id);
    team.push();
  }),
  'link.set': op(z.object({ from: id, to: id, weight: z.number().min(0.1).max(1) }), ({ team }, a) => team.setLink(a)),

  // Limits
  'guard.set': op(
    z.object({
      minFiveHour: z.number().min(0).max(90).optional(),
      minWeek: z.number().min(0).max(90).optional(),
      paused: z.boolean().optional(),
    }),
    ({ guard }, a) => guard.set(a),
  ),
  'guard.override': op(z.object({}), ({ guard }) => guard.override()),
  'guard.check': op(z.object({}), ({ guard }) => guard.check()),
  usage: op(z.object({ days: z.number().int().min(1).max(90) }), ({ store }, a) => store.usage(Date.now() - a.days * 86_400_000)),

  // Notices
  'notice.read': op(z.object({ id: num.optional(), source: z.string().max(80).optional() }), ({ notices }, a) => notices.read(a)),
  'notice.alerts': op(z.object({ on: z.boolean() }), ({ store }, a) => store.set('alerts', a.on)),

  // Rules
  'automation.save': op(automation, ({ automations }, a) => automations.save(a)),
  'automation.remove': op(z.object({ id: num }), ({ automations }, a) => automations.remove(a.id)),

  // Project commands
  'command.list': op(z.object({ space: id }), ({ commands, spaces }, a) => commands.list(spaces.get(a.space))),
  'command.trust': op(z.object({ space: id }), ({ commands, spaces }, a) => commands.trust(spaces.get(a.space))),
  'command.run': op(z.object({ space: id, name: z.string().max(80), ...size }), (c, a) => {
    const space = c.spaces.get(a.space);
    return c.terms.open({ spaceId: space.id, cwd: space.folder, cols: a.cols, rows: a.rows, run: c.commands.text(space, a.name) });
  }),

  events: op(
    z.object({ beeId: id, before: num.optional(), limit: num.max(500).optional() }),
    ({ store }, a) => store.events(a.beeId, a.before, a.limit),
  ),

  // Terminals
  'term.open': op(
    z.object({
      space: id,
      kind: z.enum(['shell', 'claude', 'ssh']).optional(),
      host: z.string().max(255).optional(),
      cwd: z.string().max(1000).optional(),
      run: z.string().max(2000).optional(),
      ...size,
    }),
    ({ terms }, { space, ...a }) => terms.open({ spaceId: space, ...a }),
  ),
  'term.attach': op(z.object({ id }), ({ terms }, a, session) => terms.attach(a.id, () => session.watching.add(a.id))),
  'term.detach': op(z.object({ id }), (_, a, session) => void session.watching.delete(a.id)),
  'term.write': op(z.object({ id, data: z.string().max(200_000) }), ({ terms }, a) => terms.write(a.id, a.data)),
  'term.resize': op(z.object({ id, ...size }), ({ terms }, a) => terms.resize(a.id, a.cols, a.rows)),
  'term.close': op(z.object({ id }), ({ terms }, a) => terms.close(a.id)),

  // Browser panes
  'browser.open': op(z.object({ space: id, url: z.string().max(4000) }), ({ browsers }, a) => browsers.open(a.space, a.url)),
  'browser.go': op(z.object({ id, url: z.string().max(4000) }), ({ browsers }, a) => browsers.go(a.id, a.url)),
  'browser.move': op(z.object({ id, way: z.enum(['back', 'forward', 'reload']) }), ({ browsers }, a) => browsers.move(a.id, a.way)),
  'browser.size': op(
    z.object({ id, width: z.number().int().min(200).max(4000), height: z.number().int().min(150).max(4000) }),
    ({ browsers }, a) => browsers.resize(a.id, a.width, a.height),
  ),
  'browser.watch': op(z.object({ id, on: z.boolean() }), async ({ browsers }, a, session) => {
    if (a.on === session.watching.has(a.id)) return;
    if (a.on) session.watching.add(a.id);
    else session.watching.delete(a.id);
    await browsers.watch(a.id, a.on);
  }),
  'browser.input': op(z.object({ id, input: browserInput }), ({ browsers }, a) => browsers.input(a.id, a.input as BrowserInput)),
  'browser.close': op(z.object({ id }), ({ browsers }, a) => browsers.close(a.id)),
};

export async function handle(ctx: Context, name: string, args: unknown, session: Session): Promise<unknown> {
  const run = Object.hasOwn(ops, name) ? ops[name] : undefined;
  if (!run) throw new Error(`Unknown request: ${name}`);
  try {
    return (await run(ctx, args, session)) ?? null;
  } catch (err) {
    if (err instanceof z.ZodError) throw new Error(`Invalid request: ${err.issues[0]?.path.join('.')} ${err.issues[0]?.message}`);
    throw err;
  }
}
