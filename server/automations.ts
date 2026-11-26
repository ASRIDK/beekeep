import { EventEmitter } from 'node:events';
import type { Finished, Hive } from './hive.ts';
import type { Notices } from './notices.ts';
import type { Store } from './store.ts';
import type { AutomationRow } from './types.ts';

const MIN_GAP_MS = 60_000;

/** Whether a timed rule should run now. */
export function isDue(a: AutomationRow, now: number): boolean {
  if (!a.enabled) return false;
  if (a.when.type === 'every') return now - (a.lastRun ?? 0) >= Math.max(1, a.when.minutes) * 60_000;
  if (a.when.type === 'daily') {
    const [h = 0, m = 0] = a.when.at.split(':').map(Number);
    const today = new Date(now);
    today.setHours(h, m, 0, 0);
    return now >= today.getTime() && (a.lastRun ?? 0) < today.getTime();
  }
  return false;
}

/** "When this happens, do that." Orders from rules wait behind yours and obey the usage guard. */
export class Automations extends EventEmitter {
  private store: Store;
  private hive: Hive;
  private notices: Notices;
  private timer: NodeJS.Timeout | null = null;

  constructor(store: Store, hive: Hive, notices: Notices) {
    super();
    this.store = store;
    this.hive = hive;
    this.notices = notices;
    hive.on('finished', (f: Finished) => this.onFinished(f));
  }

  list(): AutomationRow[] {
    return this.store.automations();
  }

  save(a: Omit<AutomationRow, 'id' | 'lastRun'> & { id?: number }): AutomationRow {
    if (!a.name.trim()) throw new Error('Give the rule a name.');
    const old = this.list().find((x) => x.id === a.id);
    // A new daily rule starts with its next time, not with one already past today.
    const row = this.store.saveAutomation({ ...a, name: a.name.trim(), lastRun: old?.lastRun ?? Date.now() });
    this.push();
    return row;
  }

  remove(id: number): void {
    this.store.removeAutomation(id);
    this.push();
  }

  start(): void {
    this.timer = setInterval(() => this.tick(Date.now()), 20_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  tick(now: number): void {
    for (const a of this.list()) if (isDue(a, now)) this.run(a, now);
  }

  private onFinished(f: Finished): void {
    // A rule must not set itself off again.
    if (f.order.source === 'auto') return;
    const now = Date.now();
    for (const a of this.list()) {
      if (!a.enabled || a.when.type !== 'finished' || a.when.beeId !== f.bee.id) continue;
      if (a.when.status !== 'any' && a.when.status !== f.status) continue;
      if (now - (a.lastRun ?? 0) < MIN_GAP_MS && a.then.type === 'order') continue;
      this.run(a, now);
    }
  }

  private run(a: AutomationRow, now: number): void {
    this.store.saveAutomation({ ...a, lastRun: now });
    try {
      if (a.then.type === 'order') this.hive.order(a.then.beeId, a.then.text, { source: 'auto' });
      else this.notices.add({ kind: 'info', spaceId: a.spaceId, source: 'hive', title: a.then.title, body: a.name });
    } catch (err) {
      this.notices.add({
        kind: 'problem',
        spaceId: a.spaceId,
        source: 'hive',
        title: `Rule "${a.name}" could not run`,
        body: err instanceof Error ? err.message : String(err),
      });
    }
    this.push();
  }

  private push(): void {
    this.emit('push', { ev: 'automations', automations: this.list() });
  }
}
