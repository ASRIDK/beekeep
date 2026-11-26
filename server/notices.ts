import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Store } from './store.ts';
import type { NoticeRow } from './types.ts';

export type NewNotice = Pick<NoticeRow, 'kind' | 'spaceId' | 'source' | 'title' | 'body'>;

const QUIET_MS = 3000;

/** A macOS alert. Text is passed as arguments, never as part of the script. */
export function macAlert(title: string, body: string): void {
  execFile(
    '/usr/bin/osascript',
    [
      '-e', 'on run argv',
      '-e', 'display notification (item 2 of argv) with title (item 1 of argv)',
      '-e', 'end run',
      '--', title, body,
    ],
    { timeout: 5000 },
    () => {},
  );
}

/** Everything that wants the person's attention, in one list. Emits 'push'. */
export class Notices extends EventEmitter {
  private store: Store;
  private alert: (title: string, body: string) => void;
  private lastAlert = new Map<string, number>();
  /** Windows the person is looking at right now. */
  private watching = 0;

  constructor(store: Store, alert: (title: string, body: string) => void = macAlert) {
    super();
    this.store = store;
    this.alert = alert;
  }

  add(n: NewNotice): NoticeRow {
    const row = this.store.addNotice({ ...n, title: clean(n.title, 120), body: clean(n.body, 500) });
    this.push();
    const last = this.lastAlert.get(n.source) ?? 0;
    const wanted = this.store.get('alerts') !== false;
    if (wanted && this.watching === 0 && Date.now() - last > QUIET_MS) {
      this.lastAlert.set(n.source, Date.now());
      this.alert(row.title, row.body || ' ');
    }
    return row;
  }

  read(which: { id?: number; source?: string } = {}): void {
    this.store.readNotices(which);
    this.push();
  }

  watch(change: 1 | -1): void {
    this.watching = Math.max(0, this.watching + change);
  }

  private push(): void {
    this.emit('push', { ev: 'notices', notices: this.store.notices() });
  }
}

/** Terminal programs can send anything, so drop control characters. */
function clean(text: string, max: number): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').trim().slice(0, max);
}
