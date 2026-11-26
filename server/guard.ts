import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { Store } from './store.ts';
import type { GuardState } from './types.ts';

const OVERRIDE_MS = 60 * 60_000;

/** Reads the percentages out of quota-axi's JSON. */
export function readQuota(text: string): Pick<GuardState, 'fiveHour' | 'week' | 'resets'> | null {
  try {
    const providers = (JSON.parse(text) as { providers?: Record<string, unknown>[] }).providers ?? [];
    const claude = providers.find((p) => p.provider === 'claude');
    const windows = (claude?.windows ?? []) as { id: string; percentRemaining?: number; resetsAt?: string }[];
    const get = (id: string) => windows.find((w) => w.id === id);
    const pct = (id: string) => {
      const v = get(id)?.percentRemaining;
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    if (pct('five_hour') === null && pct('seven_day') === null) return null;
    return {
      fiveHour: pct('five_hour'),
      week: pct('seven_day'),
      resets: { fiveHour: get('five_hour')?.resetsAt ?? null, week: get('seven_day')?.resetsAt ?? null },
    };
  } catch {
    return null;
  }
}

/**
 * Keeps the hive from using up the person's plan. Holds new work back when too
 * little is left, or when the person pauses everything. Emits 'change'.
 */
export class Guard extends EventEmitter {
  private store: Store;
  private state: GuardState;
  private tool: string | null;
  private timer: NodeJS.Timeout | null = null;
  /** Set by the plan itself refusing a step, until that window resets. */
  private refusedUntil = 0;

  constructor(store: Store, tool: string | null = findQuotaTool()) {
    super();
    this.store = store;
    this.tool = tool;
    const saved = (store.get('guard') ?? {}) as Partial<GuardState>;
    this.state = {
      fiveHour: null,
      week: null,
      resets: { fiveHour: null, week: null },
      minFiveHour: saved.minFiveHour ?? 20,
      minWeek: saved.minWeek ?? 10,
      blocked: null,
      paused: saved.paused ?? false,
      overrideUntil: null,
      checkedAt: null,
    };
  }

  get(): GuardState {
    return { ...this.state, blocked: this.why() };
  }

  /** Why new work must wait, or null. */
  why(now = Date.now()): string | null {
    const s = this.state;
    if (s.paused) return 'Everything is paused.';
    if (s.overrideUntil && s.overrideUntil > now) return null;
    if (this.refusedUntil > now) return 'Your plan refused the last step. Waiting for its limit to reset.';
    if (s.fiveHour !== null && s.fiveHour < s.minFiveHour) {
      return `Only ${Math.round(s.fiveHour)}% of the 5-hour limit is left (Beekeep stops at ${s.minFiveHour}%).`;
    }
    if (s.week !== null && s.week < s.minWeek) {
      return `Only ${Math.round(s.week)}% of the weekly limit is left (Beekeep stops at ${s.minWeek}%).`;
    }
    return null;
  }

  set(change: Partial<Pick<GuardState, 'minFiveHour' | 'minWeek' | 'paused'>>): void {
    Object.assign(this.state, change);
    const { minFiveHour, minWeek, paused } = this.state;
    this.store.set('guard', { minFiveHour, minWeek, paused });
    this.emit('change');
  }

  /** The person says: keep going for an hour anyway. */
  override(): void {
    this.state.overrideUntil = Date.now() + OVERRIDE_MS;
    this.refusedUntil = 0;
    this.emit('change');
    setTimeout(() => this.emit('change'), OVERRIDE_MS + 100).unref();
  }

  /** From the bees themselves: Claude reports limits while they work. */
  heard(info: Record<string, unknown>): void {
    if (info.status !== 'rejected') return;
    const resets = Number(info.resetsAt ?? 0) * 1000;
    this.refusedUntil = resets > Date.now() ? resets : Date.now() + 15 * 60_000;
    this.emit('change');
  }

  start(everyMs = 90_000): void {
    void this.check();
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async check(): Promise<void> {
    if (!this.tool) return;
    const text = await new Promise<string>((done) => {
      execFile(
        this.tool!,
        ['--provider', 'claude', '--json', '--max-age', '60s'],
        { timeout: 30_000, env: { ...process.env, PATH: `${dirname(this.tool!)}${delimiter}${process.env.PATH ?? ''}` } },
        (_err, out) => done(String(out)),
      );
    });
    const quota = readQuota(text);
    if (!quota) return;
    Object.assign(this.state, quota, { checkedAt: Date.now() });
    this.emit('change');
  }
}

/** quota-axi is a global npm tool, so it may sit under any Node version. */
function findQuotaTool(): string | null {
  const nvm = join(homedir(), '.nvm/versions/node');
  const places = [
    ...(process.env.PATH ?? '').split(delimiter),
    ...(existsSync(nvm) ? readdirSync(nvm).map((v) => join(nvm, v, 'bin')) : []),
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  return places.map((d) => join(d, 'quota-axi')).find((p) => existsSync(p)) ?? null;
}
