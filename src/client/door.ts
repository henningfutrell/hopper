// The client door (issue #695, design.md "Joining a machine" → "The client door"): how a job on a client target reaches
// the hopper. The client listens on loopback here, on a port the OS picks, and passes each of a job's `/job/` requests
// (hopper-gh, git, hopper-skill, hopper-artifact, the job stream) on to the hopper's URL as this client reaches it — the
// URL it joined at and dials in to. So a job needs no name resolved and no address of the hopper's: the hopper gives it
// the door as HOPPER_URL (the client says it in `/release`). The door adds no right: every `/job/` route still asks for
// the job's proxy token. It takes only `/job/` paths, and only with its own Host (`127.0.0.1:<port>` or
// `localhost:<port>`), so a web page that rebinds a name to loopback reaches nothing through it.
// The door waits instead of failing (issue #752): while the hopper is out of reach, it holds each request and tries it
// again with backoff, up to the hold (the hopper's reconnect grace, 120 s by default) from when the hopper went away;
// after that it answers 503 with Retry-After and when the hopper went away. It tries again only a request that never
// reached the hopper (no connection was made), so no write is sent twice. Nothing is cached: every write still needs the
// hopper.
// Imports nothing of hopper: it is one of the client's files.
import { createServer, request as httpRequest, type ClientRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

/** The paths a job asks the hopper at; nothing else goes through the door. */
const JOB_PREFIX = '/job/';
/** Headers of one hop only: never passed on. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

/** How long the door holds requests from when the hopper went out of reach: the hopper's reconnect grace by default. */
export const DOOR_HOLD_MS = 120_000;
/** The Retry-After of the door's 503, in seconds. */
export const DOOR_RETRY_AFTER_S = 30;
/** How long a connection to the hopper may take to open, before the door takes the hopper as out of reach. */
const CONNECT_MS = 10_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 5000;

export interface DoorOptions {
  /** The hopper's URL, as this client reaches it. */
  url: string;
  /** How long requests are held from when the hopper went out of reach (default `DOOR_HOLD_MS`). */
  holdMs?: number;
  /** The Retry-After of the 503 after the hold (default `DOOR_RETRY_AFTER_S`). */
  retryAfterS?: number;
  log?: (line: string) => void;
}

export interface Door {
  /** The door's URL: `http://127.0.0.1:<port>`. */
  url: string;
  stop(): Promise<void>;
}

const plain = (res: ServerResponse, status: number, text: string): void => {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(`${text}\n`);
};

function headersOf(req: IncomingMessage, host: string): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = { host };
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) out[k] = v;
  return out;
}

/** Opens the door on loopback. */
export function startDoor(o: DoorOptions): Promise<Door> {
  const hopper = new URL(o.url);
  const send = hopper.protocol === 'https:' ? httpsRequest : httpRequest;
  const holdMs = o.holdMs ?? DOOR_HOLD_MS;
  let port = 0;
  /** When the hopper went out of reach; undefined while it answers. */
  let awaySince: number | undefined;
  const away = (why: string): void => {
    if (awaySince !== undefined) return;
    awaySince = Date.now();
    o.log?.(`hopper-client: door: the hopper at ${o.url} is out of reach (${why}); holding job requests`);
  };
  const back = (): void => {
    if (awaySince === undefined) return;
    o.log?.(`hopper-client: door: the hopper at ${o.url} is back after ${Math.round((Date.now() - awaySince) / 1000)} s`);
    awaySince = undefined;
  };

  /** One try at passing a request on. `retry`: the connection could not be made, and the hold has not ended. */
  const pass = (req: IncomingMessage, res: ServerResponse, path: string, retry: () => void): ClientRequest => {
    let connected = false;
    // A fresh connection per request: a reused one could have carried the request before it broke.
    const out = send({
      protocol: hopper.protocol, hostname: hopper.hostname, port: hopper.port, method: req.method, path, headers: headersOf(req, hopper.host), agent: false,
    }, (answer) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(answer.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
      res.writeHead(answer.statusCode ?? 502, headers);
      // A streamed answer (the job stream, git) goes on as it comes.
      res.flushHeaders();
      answer.pipe(res);
      answer.on('error', () => res.destroy());
    });
    const timer = setTimeout(() => out.destroy(new Error(`no connection within ${CONNECT_MS / 1000} s`)), CONNECT_MS);
    out.once('socket', (socket) => {
      socket.once(hopper.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        connected = true;
        back();
        // The body goes on only once the hopper is there: until then it waits in the job's request, to be sent again.
        req.pipe(out);
      });
    });
    out.on('error', (e) => {
      clearTimeout(timer);
      if (res.destroyed || res.writableEnded) return;
      o.log?.(`hopper-client: door: ${req.method} ${path.split('?')[0]}: ${e.message}`);
      const cannot = `this machine cannot reach the hopper at ${o.url}: ${e.message}`;
      // Connected: the hopper may have taken the request, so it is not sent again.
      if (connected) return plain(res, 502, cannot);
      away(e.message);
      if (Date.now() - awaySince! < holdMs) return retry();
      res.setHeader('retry-after', String(o.retryAfterS ?? DOOR_RETRY_AFTER_S));
      plain(res, 503, `the hopper is out of reach since ${new Date(awaySince!).toISOString()}; wait, do not sign in another way.\n${cannot}`);
    });
    return out;
  };

  const server = createServer((req, res) => {
    const path = req.url ?? '';
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return plain(res, 421, 'the client door takes only its own address');
    if (!path.startsWith(JOB_PREFIX)) return plain(res, 404, `the client door passes on only ${JOB_PREFIX} requests`);
    let out: ClientRequest | undefined;
    let again: NodeJS.Timeout | undefined;
    const attempt = (wait: number): void => {
      out = pass(req, res, path, () => { again = setTimeout(() => attempt(Math.min(wait * 2, BACKOFF_MAX_MS)), wait); });
    };
    res.on('close', () => { clearTimeout(again); if (!res.writableFinished) out?.destroy(); });
    attempt(BACKOFF_FIRST_MS);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        stop: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()); }),
      });
    });
  });
}
