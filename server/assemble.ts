// Puts the parts of Beekeep together. Used by the real server and by tests.
import { Automations } from './automations.ts';
import { Browsers } from './browser.ts';
import { Commands } from './commands.ts';
import type { StartDriver } from './driver.ts';
import { Guard } from './guard.ts';
import { type Finished, Hive, type HiveOptions } from './hive.ts';
import { macAlert, type NewNotice, Notices } from './notices.ts';
import type { Context } from './rpc.ts';
import { Spaces } from './spaces.ts';
import { Store } from './store.ts';
import { Team } from './team.ts';
import { Terms } from './terms.ts';
import type { ApprovalRow, BeeRow, TermView } from './types.ts';

export interface Parts {
  file: string;
  start: StartDriver;
  hiveCommand: string;
  alert?: (title: string, body: string) => void;
  quotaTool?: string | null;
  hive?: Partial<HiveOptions>;
}

export function assemble(p: Parts): Context {
  const store = new Store(p.file);
  const guard = p.quotaTool === undefined ? new Guard(store) : new Guard(store, p.quotaTool);
  const hive = new Hive({ ...p.hive, store, start: p.start, gate: () => guard.why() });
  const browsers = new Browsers();
  const team = new Team(hive, store, browsers);
  const terms = new Terms(store, p.hiveCommand);
  const notices = new Notices(store, p.alert ?? macAlert);
  const spaces = new Spaces(store, (id) => terms.pids(id));
  const automations = new Automations(store, hive, notices);
  const commands = new Commands(store);

  hive.on('limit', (info: Record<string, unknown>) => guard.heard(info));
  let held: string | null = null;
  guard.on('change', () => {
    const why = guard.why();
    if (why && why !== held && !guard.get().paused) {
      notices.add({ kind: 'problem', spaceId: spaces.current(), source: 'hive', title: 'New work is on hold', body: why });
    }
    // Work held back starts again by itself once there is room.
    if (!why && held) hive.resume();
    held = why;
  });

  hive.on('asked', ({ bee, approval }: { bee: BeeRow; approval: ApprovalRow }) =>
    notices.add({
      kind: 'needs',
      spaceId: bee.spaceId,
      source: `bee:${bee.id}`,
      title: `${bee.name} needs you`,
      body: approval.reason,
    }),
  );
  hive.on('finished', (f: Finished) => {
    if (f.status === 'stopped') return;
    // Steps inside a plan are news for the queen, not for the person.
    if (f.status === 'done' && f.order.taskId) return;
    // Her plan is already asking for attention.
    if (f.status === 'done' && store.plans().some((p) => p.queenId === f.bee.id && p.status === 'proposed')) return;
    notices.add({
      kind: f.status === 'done' ? 'done' : 'problem',
      spaceId: f.bee.spaceId,
      source: `bee:${f.bee.id}`,
      title: f.status === 'done' ? `${f.bee.name} is done` : `${f.bee.name} had a problem`,
      body: (f.status === 'done' ? f.said : f.detail) ?? '',
    });
  });
  team.on('news', (n: NewNotice) => notices.add(n));
  terms.on('notice', (n: { term: TermView; title: string; body: string; quiet?: boolean }) =>
    notices.add({
      kind: n.quiet ? 'done' : 'needs',
      spaceId: n.term.spaceId,
      source: `term:${n.term.id}`,
      title: n.title || n.term.title,
      body: n.body,
    }),
  );

  return { hive, team, store, terms, guard, notices, spaces, browsers, automations, commands };
}
