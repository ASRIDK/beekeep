// What the `beekeep` command and other Claude sessions (over MCP) may do. They can
// look, give orders and leave notes. They can never approve anything, change what
// a bee may do, or speak as the person: that takes the window.
import { z } from 'zod';
import type { Context } from './rpc.ts';

const text = z.string().min(1).max(20_000);
const name = z.string().min(1).max(64);

interface Op {
  about: string;
  shape: z.ZodObject;
  /** Offered to other Claude sessions as a tool. */
  mcp: boolean;
  run: (c: Context, a: never) => unknown;
}

function op<S extends z.ZodObject>(about: string, shape: S, run: (c: Context, a: z.infer<S>) => unknown, mcp = true): Op {
  return { about, shape, mcp, run: run as Op['run'] };
}

function findBee(c: Context, which: string) {
  const bee = c.hive.views().find((b) => b.id === which || b.name.toLowerCase() === which.toLowerCase());
  if (!bee) throw new Error(`There is no bee called "${which}".`);
  return bee;
}

function findTerm(c: Context, which: string) {
  const all = c.terms.list();
  const t = all.find((x) => x.id === which) ?? all.find((x) => x.title.toLowerCase() === which.toLowerCase());
  if (!t) throw new Error(`There is no terminal called "${which}".`);
  return t;
}

/** What a bee said last during one order. */
function report(c: Context, orderId: number): string {
  const order = c.store.order(orderId)!;
  const events = c.store.events(order.beeId, undefined, 500);
  const from = events.findIndex((e) => e.kind === 'order' && e.data.orderId === orderId);
  if (from < 0) return '';
  const rest = events.slice(from + 1);
  const to = rest.findIndex((e) => e.kind === 'order');
  const said = (to < 0 ? rest : rest.slice(0, to)).filter((e) => e.kind === 'say' && !e.data.helper);
  return String(said.at(-1)?.data.text ?? '');
}

export const API: Record<string, Op> = {
  list_bees: op('List the bees in Beekeep: role, what each may do, and whether it is busy.', z.object({}), (c) =>
    c.hive.views().map((b) => ({
      name: b.name,
      kind: b.kind,
      role: b.role,
      may: b.mode,
      model: b.model,
      folder: b.workspace,
      state: b.status,
      space: c.spaces.list().find((s) => s.id === b.spaceId)?.name,
    })),
  ),
  send_order: op(
    'Give a bee an order. It waits behind the keeper’s own orders. Returns the order number.',
    z.object({ bee: name, text }),
    (c, a) => ({ order: c.hive.order(findBee(c, a.bee).id, a.text, { source: 'outside' }).id }),
  ),
  check_order: op('State of an order and the bee’s report so far.', z.object({ order: z.number().int() }), (c, a) => {
    const o = c.store.order(a.order);
    if (!o) throw new Error('No such order.');
    return { order: o.id, state: o.status, report: report(c, o.id) };
  }),
  read_board: op('Read Beekeep’s shared board.', z.object({ topic: z.string().max(60).optional() }), (c, a) =>
    c.store
      .board(undefined, 100)
      .filter((r) => !a.topic || r.topic.toLowerCase() === a.topic.toLowerCase())
      .map((r) => ({ topic: r.topic, by: c.team.nameOf(r.author), text: r.text })),
  ),
  post: op('Put a note on Beekeep’s shared board.', z.object({ topic: z.string().max(60), text }), (c, a) => {
    c.team.post(c.spaces.current(), 'outside', a.topic, a.text);
    return 'Posted.';
  }),
  notify: op(
    'Show the keeper a notice in Beekeep.',
    z.object({ title: z.string().max(120), body: z.string().max(500).optional(), term: z.string().optional() }),
    (c, a) => {
      const t = a.term ? c.terms.list().find((x) => x.id === a.term) : undefined;
      c.notices.add({
        kind: 'info',
        spaceId: t?.spaceId ?? c.spaces.current(),
        source: t ? `term:${t.id}` : 'hive',
        title: a.title,
        body: a.body ?? '',
      });
      return 'Shown.';
    },
  ),
  list_terminals: op('List Beekeep’s terminals.', z.object({}), (c) =>
    c.terms.list().map((t) => ({ id: t.id, title: t.title, folder: t.cwd, kind: t.kind, state: t.agent ?? (t.alive ? 'open' : 'ended') })),
  ),
  read_terminal: op(
    'Read what a Beekeep terminal shows.',
    z.object({ terminal: name, lines: z.number().int().min(1).max(500).optional() }),
    (c, a) => c.terms.text(findTerm(c, a.terminal).id, a.lines ?? 60),
  ),
  list_plans: op('The queens’ plans and their tasks.', z.object({}), (c) =>
    c.store.plans(10).map((p) => ({
      id: p.id,
      goal: p.goal,
      state: p.status,
      tasks: c.store.tasks(p.id).map((t) => ({ key: t.key, bee: c.team.nameOf(t.beeId), state: t.status })),
    })),
  ),

  // For the command line only
  type: op(
    'Type into a terminal.',
    z.object({ terminal: name, text: z.string().max(20_000), enter: z.boolean().optional() }),
    async (c, a) => {
      const { id } = findTerm(c, a.terminal);
      if (a.text) c.terms.write(id, a.text);
      if (a.enter !== false) {
        // Together they would count as pasted text, and Enter would not send it.
        await new Promise((r) => setTimeout(r, 150));
        c.terms.write(id, '\r');
      }
      return 'Typed.';
    },
    false,
  ),
  new_terminal: op(
    'Open a terminal.',
    z.object({
      cwd: z.string().max(1000).optional(),
      run: z.string().max(2000).optional(),
      claude: z.boolean().optional(),
      ssh: z.string().max(255).optional(),
    }),
    (c, a) =>
      c.terms.open({
        spaceId: c.spaces.current(),
        kind: a.ssh ? 'ssh' : a.claude ? 'claude' : 'shell',
        host: a.ssh,
        cwd: a.cwd ?? c.spaces.get(c.spaces.current()).folder,
        run: a.run,
        cols: 100,
        rows: 30,
      }).id,
    false,
  ),
  open_browser: op(
    'Open a browser pane.',
    z.object({ url: z.string().max(4000) }),
    async (c, a) => (await c.browsers.open(c.spaces.current(), a.url)).id,
    false,
  ),
  new_space: op(
    'Make a space.',
    z.object({ name: z.string().max(60), folder: z.string().max(1000) }),
    (c, a) => c.spaces.create(a.name, a.folder).id,
    false,
  ),
  windows: op('How many windows are open.', z.object({}), (c) => c.windows?.() ?? 0, false),
  guard: op('Plan limits left.', z.object({}), (c) => c.guard.get(), false),
  hook: op(
    'A Claude pane reports on itself.',
    z.object({
      term: name,
      event: z.object({
        hook_event_name: z.string().max(60).optional(),
        session_id: z.string().max(100).optional(),
        message: z.string().max(2000).optional(),
      }),
    }),
    (c, a) => {
      c.terms.hook(a.term, a.event);
      return 'ok';
    },
    false,
  ),
};

export async function callApi(ctx: Context, opName: string, args: unknown): Promise<unknown> {
  const found = Object.hasOwn(API, opName) ? API[opName] : undefined;
  if (!found) throw new Error(`Unknown command: ${opName}`);
  const parsed = found.shape.safeParse(args ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue?.path.join('.')}: ${issue?.message}`);
  }
  return found.run(ctx, parsed.data as never);
}
