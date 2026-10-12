// The client door (issue #695, design.md "Joining a machine" → "The client door"): how a job on a client target reaches
// the hopper. The client listens on loopback here, on a port the OS picks, and passes each of a job's `/job/` requests
// (hopper-gh, git, hopper-skill, hopper-artifact, the job stream) on to the hopper's URL as this client reaches it — the
// URL it joined at and dials in to. So a job needs no name resolved and no address of the hopper's: the hopper gives it
// the door as HOPPER_URL (the client says it in `/release`). The door adds no right: every `/job/` route still asks for
// the job's proxy token. It takes only `/job/` paths, and only with its own Host (`127.0.0.1:<port>` or
// `localhost:<port>`), so a web page that rebinds a name to loopback reaches nothing through it.
// Imports nothing of hopper: it is one of the client's files.
import { createServer, request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

/** The paths a job asks the hopper at; nothing else goes through the door. */
const JOB_PREFIX = '/job/';
/** Headers of one hop only: never passed on. */
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);

export interface DoorOptions {
  /** The hopper's URL, as this client reaches it. */
  url: string;
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
  let port = 0;
  const server = createServer((req, res) => {
    const path = req.url ?? '';
    if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) return plain(res, 421, 'the client door takes only its own address');
    if (!path.startsWith(JOB_PREFIX)) return plain(res, 404, `the client door passes on only ${JOB_PREFIX} requests`);
    const out = send({
      protocol: hopper.protocol, hostname: hopper.hostname, port: hopper.port, method: req.method, path, headers: headersOf(req, hopper.host),
    }, (answer) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [k, v] of Object.entries(answer.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
      res.writeHead(answer.statusCode ?? 502, headers);
      // A streamed answer (the job stream, git) goes on as it comes.
      res.flushHeaders();
      answer.pipe(res);
      answer.on('error', () => res.destroy());
    });
    out.on('error', (e) => {
      o.log?.(`hopper-client: door: ${req.method} ${path.split('?')[0]}: ${e.message}`);
      plain(res, 502, `this machine cannot reach the hopper at ${o.url}: ${e.message}`);
    });
    req.pipe(out);
    res.on('close', () => { if (!res.writableFinished) out.destroy(); });
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
