// The terminal's side of the socket: the same live copy of the hive a window has.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { EventRow, Snapshot } from '../server/types.ts';

export interface View extends Omit<Snapshot, 'currentSpace' | 'layouts'> {
  events: Record<string, EventRow[]>;
  typing: Record<string, string>;
}

type Pending = { ok: (v: unknown) => void; fail: (e: Error) => void };

/** Emits 'change' when anything shown may have changed, and 'closed' with the close code. */
export class Link extends EventEmitter {
  view: View | null = null;
  private ws: WebSocket | null = null;
  private next = 1;
  private pending = new Map<number, Pending>();
  private port: number;
  private token: string;

  constructor(port: number, token: string) {
    super();
    this.port = port;
    this.token = token;
  }

  async connect(): Promise<void> {
    const origin = `http://127.0.0.1:${this.port}`;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/socket`, { origin });
    this.ws = ws;
    ws.on('message', (raw) => this.receive(JSON.parse(String(raw))));
    ws.on('close', (code) => {
      for (const p of this.pending.values()) p.fail(new Error('The connection to Beekeep was lost.'));
      this.pending.clear();
      this.emit('closed', code);
    });
    await new Promise<void>((ok, fail) => {
      ws.once('open', () => ok());
      ws.once('error', fail);
    });
    ws.on('error', () => {}); // 'close' follows and says what happened.
    await this.call('hello', undefined, { token: this.token });
    const snap = await this.call<Snapshot>('snapshot', {});
    this.view = { ...snap, events: {}, typing: {} };
    this.emit('change');
  }

  close(): void {
    this.ws?.close();
  }

  call<T = unknown>(op: string, args?: unknown, extra: object = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Beekeep is not connected.'));
    const id = this.next++;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, fail });
      ws.send(JSON.stringify({ id, op, args, ...extra }));
    });
  }

  /** Loads a bee's recent history once; later events arrive by themselves. */
  async watch(beeId: string): Promise<void> {
    if (!this.view || this.view.events[beeId]) return;
    this.view.events[beeId] = [];
    const rows = await this.call<EventRow[]>('events', { beeId, limit: 300 });
    this.add(beeId, rows);
  }

  private add(beeId: string, rows: EventRow[]): void {
    const v = this.view;
    if (!v) return;
    if (rows.some((e) => e.kind === 'say' || e.kind === 'turn' || e.kind === 'order')) delete v.typing[beeId];
    const known = v.events[beeId];
    if (!known) {
      this.emit('change');
      return;
    }
    const byId = new Map([...known, ...rows].map((e) => [e.id, e]));
    v.events[beeId] = [...byId.values()].sort((a, b) => a.id - b.id).slice(-1000);
    this.emit('change');
  }

  private receive(m: Record<string, unknown>): void {
    if (typeof m.re === 'number') {
      const p = this.pending.get(m.re);
      this.pending.delete(m.re);
      if (m.ok) p?.ok(m.data);
      else p?.fail(new Error(String(m.error)));
      return;
    }
    const v = this.view;
    if (!v) return;
    switch (m.ev) {
      case 'typing': {
        const id = String(m.beeId);
        v.typing[id] = ((v.typing[id] ?? '') + String(m.text)).slice(-4000);
        return void this.emit('change');
      }
      case 'event': {
        const e = m.event as EventRow;
        return this.add(e.beeId, [e]);
      }
      case 'term':
      case 'frame':
      case 'message':
        return;
      default: {
        // The rest are whole parts of the state, named as they are in the snapshot.
        const { ev: _, ...parts } = m;
        Object.assign(v, parts);
        this.emit('change');
      }
    }
  }
}
