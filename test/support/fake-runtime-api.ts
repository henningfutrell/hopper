// A container runtime's API double (issue #708): an HTTP server on a unix socket, as Podman's and Docker's are. It
// records every request, and answers each with what the test's handler says (else 404), so an adapter's request
// shapes are checked without a real runtime.
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface SeenRequest { method: string; path: string; query: URLSearchParams; body: unknown }
/** `bytes`: a body sent as it is, binary (a container's framed logs). `after`: the answer is sent once it settles (a box that runs on). */
export interface Reply { status: number; body?: unknown; text?: string; bytes?: Buffer; after?: Promise<unknown> }
export type Handler = (r: SeenRequest) => Reply | undefined;

export interface FakeRuntimeApi {
  socket: string;
  seen: SeenRequest[];
  /** The handlers, tried in order; the first that answers wins. */
  handlers: Handler[];
  close(): Promise<void>;
}

export async function startFakeRuntimeApi(handlers: Handler[] = []): Promise<FakeRuntimeApi> {
  const dir = mkdtempSync(join(tmpdir(), 'rt-'));
  const socket = join(dir, 'api.sock');
  const api: FakeRuntimeApi = { socket, seen: [], handlers, close: async () => {} };
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { raw += d; });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const seen: SeenRequest = { method: req.method ?? '', path: url.pathname, query: url.searchParams, body: raw ? (String(req.headers['content-type']).includes('json') ? JSON.parse(raw) : raw) : undefined };
      api.seen.push(seen);
      let reply: Reply | undefined;
      // The first handler that answers wins, and the ones after it are not asked: a handler may change what it keeps.
      for (const h of api.handlers) if ((reply = h(seen)) !== undefined) break;
      reply ??= { status: 404, body: { message: 'no such thing' } };
      void Promise.resolve(reply.after).catch(() => undefined).then(() => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(reply.bytes ?? reply.text ?? (reply.body === undefined ? '' : JSON.stringify(reply.body)));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  api.close = () => new Promise<void>((resolve) => server.close(() => { rmSync(dir, { recursive: true, force: true }); resolve(); }));
  return api;
}

/** A handler for one method and path (a RegExp matches the whole path). */
export const on = (method: string, path: string | RegExp, reply: Reply | ((r: SeenRequest) => Reply)): Handler => (r) => {
  if (r.method !== method) return undefined;
  if (typeof path === 'string' ? r.path !== path : !path.test(r.path)) return undefined;
  return typeof reply === 'function' ? reply(r) : reply;
};
