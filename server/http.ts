import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { callApi } from './api.ts';
import { handle, type Context, type Session } from './rpc.ts';

/** Close code that tells a window Beekeep was stopped on purpose. */
export const STOPPED = 4000;

export interface HttpOptions {
  ctx: Context;
  /** Secret of this launch. Whoever holds it can run shells, so it never leaves this computer. */
  token: string;
  dist: string;
  onStop?: () => void;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

const CODE_LIFE_MS = 60_000;
const HELLO_LIMIT_MS = 5_000;

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Local-only web server. Other websites open in the same browser must not reach
 * it, so every request is checked for Host (blocks DNS rebinding) and, where a
 * browser is involved, Origin. Control goes over one socket that must present
 * the launch secret first.
 */
export function createHttp(opts: HttpOptions): { server: Server; close: (goodbye?: boolean) => Promise<void>; windows: () => number } {
  const codes = new Map<string, number>();
  const windows = new Map<WebSocket, Session>();

  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch {
      end(res, 500, 'Something went wrong.');
    }
  });

  const port = () => (server.address() as { port: number }).port;
  const hosts = () => [`127.0.0.1:${port()}`, `localhost:${port()}`];
  const hostOk = (req: IncomingMessage) => hosts().includes(req.headers.host ?? '');
  const originOk = (req: IncomingMessage) => hosts().some((h) => req.headers.origin === `http://${h}`);

  function route(req: IncomingMessage, res: ServerResponse): void {
    if (!hostOk(req)) return end(res, 403, 'Wrong host.');
    const path = new URL(req.url ?? '/', 'http://x').pathname;

    if (req.method === 'POST' && (path === '/code' || path === '/stop' || path === '/api')) {
      // For the `beekeep` command only: browsers always send Origin on POST.
      if (req.headers.origin !== undefined || !same(req.headers.authorization ?? '', `Bearer ${opts.token}`)) {
        return end(res, 403, 'Not allowed.');
      }
      if (path === '/api') {
        readBody(
          req,
          (body) => {
            const { op, args } = JSON.parse(body) as { op: string; args: unknown };
            callApi(opts.ctx, String(op), args).then(
              (out) => end(res, 200, JSON.stringify(out ?? 'ok'), 'application/json'),
              (err) => end(res, 400, err instanceof Error ? err.message : String(err)),
            );
          },
          () => end(res, 400, 'Bad request.'),
          256 * 1024,
        );
        return;
      }
      if (path === '/stop') {
        end(res, 200, 'Stopping.');
        opts.onStop?.();
        return;
      }
      const code = randomBytes(24).toString('base64url');
      codes.set(code, Date.now() + CODE_LIFE_MS);
      return end(res, 200, JSON.stringify({ code }), 'application/json');
    }

    if (req.method === 'POST' && path === '/claim') {
      if (!originOk(req)) return end(res, 403, 'Not allowed.');
      readBody(req, (body) => {
        const code = (JSON.parse(body) as { code?: string }).code ?? '';
        const until = codes.get(code);
        codes.delete(code);
        if (!until || until < Date.now()) return end(res, 403, 'This link has expired. Run beekeep again.');
        end(res, 200, JSON.stringify({ token: opts.token }), 'application/json');
      }, () => end(res, 400, 'Bad request.'));
      return;
    }

    if (req.method === 'GET' && path === '/health') return end(res, 200, 'hive');
    if (req.method === 'GET' || req.method === 'HEAD') return file(path, res);
    end(res, 405, 'Not allowed.');
  }

  function file(path: string, res: ServerResponse): void {
    const rel = normalize(decodeURIComponent(path)).replace(/^[/\\]+/, '');
    const full = join(opts.dist, rel || 'index.html');
    if (full !== opts.dist && !full.startsWith(opts.dist + sep)) return end(res, 404, 'Not found.');
    const stat = statSync(full, { throwIfNoEntry: false });
    if (!stat?.isFile()) return end(res, 404, 'Not found.');
    res.writeHead(200, { ...headers(TYPES[extname(full)] ?? 'application/octet-stream'), 'Content-Length': stat.size });
    createReadStream(full).pipe(res);
  }

  function headers(type: string): Record<string, string> {
    return {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Content-Security-Policy': [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "font-src 'self' data:",
        `connect-src 'self' ${hosts().map((h) => `ws://${h}`).join(' ')}`,
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    };
  }

  function end(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
    res.writeHead(status, headers(type));
    res.end(body);
  }

  // One socket per window

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (!hostOk(req) || !originOk(req) || new URL(req.url ?? '/', 'http://x').pathname !== '/socket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, accept);
  });

  function accept(ws: WebSocket): void {
    const late = setTimeout(() => ws.close(4401, 'No hello.'), HELLO_LIMIT_MS);
    ws.on('close', () => {
      clearTimeout(late);
      const s = windows.get(ws);
      windows.delete(ws);
      if (!s) return;
      if (s.focused) opts.ctx.notices.watch(-1);
      const pages = new Set(opts.ctx.browsers.list().map((b) => b.id));
      for (const id of s.watching) if (pages.has(id)) void opts.ctx.browsers.watch(id, false).catch(() => {});
    });
    ws.on('error', () => ws.terminate());
    ws.on('message', (raw) => {
      let msg: { id?: number; op?: string; args?: unknown; token?: string };
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return ws.close(4400, 'Bad message.');
      }
      const session = windows.get(ws);
      if (!session) {
        clearTimeout(late);
        if (msg.op !== 'hello' || typeof msg.token !== 'string' || !same(msg.token, opts.token)) {
          return ws.close(4401, 'Not allowed.');
        }
        windows.set(ws, { watching: new Set(), focused: false });
        return send(ws, { re: msg.id, ok: true, data: null });
      }
      handle(opts.ctx, String(msg.op), msg.args, session).then(
        (data) => send(ws, { re: msg.id, ok: true, data }),
        (err) => send(ws, { re: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
    });
  }

  function send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  function broadcast(msg: unknown): void {
    for (const ws of windows.keys()) send(ws, msg);
  }

  const { ctx } = opts;
  for (const part of [ctx.hive, ctx.team, ctx.notices, ctx.spaces, ctx.automations]) part.on('push', broadcast);
  ctx.guard.on('change', () => broadcast({ ev: 'guard', guard: ctx.guard.get() }));
  ctx.browsers.on('list', () => broadcast({ ev: 'browsers', browsers: ctx.browsers.list() }));
  ctx.browsers.on('frame', (id: string, data: string, size: object) => {
    for (const [ws, s] of windows) {
      // A window that cannot keep up skips frames instead of falling behind.
      if (s.watching.has(id) && ws.bufferedAmount < 2_000_000) send(ws, { ev: 'frame', id, data, ...size });
    }
  });
  opts.ctx.terms.on('list', () => broadcast({ ev: 'terminals', terminals: opts.ctx.terms.list() }));
  opts.ctx.terms.on('data', (id: string, data: string) => {
    for (const [ws, s] of windows) if (s.watching.has(id)) send(ws, { ev: 'term', id, data });
  });

  /**
   * Sockets outlive a plain server.close(), so end them first. With `goodbye`,
   * windows are told Beekeep was stopped on purpose, and close instead of waiting.
   */
  async function close(goodbye = false): Promise<void> {
    if (goodbye && wss.clients.size) {
      for (const ws of wss.clients) ws.close(STOPPED, 'Beekeep was stopped.');
      await new Promise((r) => setTimeout(r, 300));
    }
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    return new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  return { server, close, windows: () => windows.size };
}

function readBody(req: IncomingMessage, done: (body: string) => void, fail: () => void, max = 4096): void {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (chunk: string) => {
    body += chunk;
    if (body.length > max) req.destroy();
  });
  req.on('end', () => {
    try {
      done(body);
    } catch {
      fail();
    }
  });
  req.on('error', fail);
}
