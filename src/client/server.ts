// The hopper client (design.md "Client targets", issue #59): what a client target runs. It dials in to
// the hopper's own URL (dial.ts, issue #308) and serves HTTP/2 on that link's socket: the hopper sends
// its calls down it. Three routes:
// `POST /herdr {args, timeoutMs?}` runs `<herdrBin> --session <session> <args>` with no shell and
// answers `{code, stdout, stderr}` — the binary and the session are the client's own, never the
// request's; `POST /release` answers `{release, home}`, the id of the release this process runs
// (release.ts, issue #70) and this user's home, where `~` in a job's work tree resolves (issue #323); `POST /load {release}` writes the hopper's release into the install dir
// and then asks to be restarted (`onLoaded`; main.ts exits and the unit starts the new files).
// A request runs only when the hopper signed it with the client's token (signature.ts); every answer
// is signed back. When the link ends, or a dial fails, the client dials again, backing off to 30 s.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { performServerHandshake, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { Duplex } from 'node:stream';
import { checkRelease, installRelease, readRelease } from './release.ts';
import { REQUEST_HEADER, RESPONSE_HEADER, checkToken, createNonceCache, signResponse, verifyRequest } from './signature.ts';

const MAX_BODY = 1024 * 1024;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** A link that stayed up this long starts the backoff over. */
const STABLE_MS = 60000;

export interface ClientOptions {
  /** The client's token, read at each request so a rotated one is used at once. */
  token: () => string;
  /** This machine's herdr binary (absolute) and the session the hopper's jobs run in (never `default`). */
  herdrBin: string;
  session: string;
  /** Dials the hopper once: resolves the link's socket (dial.ts), or rejects. */
  dial: () => Promise<Duplex>;
  log?: (line: string) => void;
  /** Delays between dials; default 1 s, 2 s, 5 s, 10 s, then 30 s. */
  backoffMs?: readonly number[];
  /** The directory this client's files are installed in: its release is read from it at start, and a load writes there. */
  installDir: string;
  /** A release was loaded into installDir: restart to run it. Called after the answer is sent. */
  onLoaded?: (release: string) => void;
}

export interface Client { stop(): Promise<void> }

function herdr(o: ClientOptions, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(o.herdrBin, ['--session', o.session, ...args], { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve({ code: 124, stdout, stderr: `herdr timed out after ${timeoutMs} ms` });
      resolve({ code: typeof e.code === 'number' ? e.code : 127, stdout, stderr: stderr || e.message });
    });
  });
}

const validArgs = (v: unknown): v is string[] =>
  Array.isArray(v) && v.length > 0 && v.every((a) => typeof a === 'string') && !v.includes('--session');

function readBody(stream: ServerHttp2Stream): Promise<string | 'too large'> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { resolve('too large'); return; }
      if (size <= MAX_BODY) chunks.push(c);
    });
    stream.on('end', () => resolve(size > MAX_BODY ? 'too large' : Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

/** One request on the tunnel: verified, then run; the answer signed. */
const ROUTES = new Set(['/herdr', '/release', '/load']);

/** What a client knows of its releases: the one it runs, and the one a load put in its install dir. */
interface Releases { running: string; installed: string }

async function serve(o: ClientOptions, nonces: ReturnType<typeof createNonceCache>, releases: Releases, stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<void> {
  const body = await readBody(stream);
  let nonce = '';
  const answer = (status: number, payload: unknown): void => {
    const text = JSON.stringify(payload);
    if (stream.destroyed) return;
    stream.respond({ ':status': status, 'content-type': 'application/json', ...(nonce ? { [RESPONSE_HEADER]: signResponse(o.token(), nonce, status, text) } : {}) });
    stream.end(text);
  };
  const method = String(headers[':method']);
  const path = String(headers[':path']);
  if (body === 'too large') return answer(413, { error: 'body too large' });
  if (method !== 'POST' || !ROUTES.has(path)) return answer(404, { error: 'not found' });
  const header = headers[REQUEST_HEADER];
  const v = verifyRequest(o.token(), typeof header === 'string' ? header : undefined, method, path, body, nonces);
  if (!v.ok) {
    o.log?.(`hopper-client: refused a request: ${v.why}`);
    return answer(401, { error: `refused: ${v.why}` });
  }
  nonce = v.nonce;
  if (path === '/release') return answer(200, { release: releases.running, home: homedir(), ...diskOfHome() });
  if (path === '/load') return load(o, releases, stream, body, answer);
  let parsed: { args?: unknown; timeoutMs?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { return answer(400, { error: 'body must be JSON' }); }
  if (!validArgs(parsed.args)) return answer(400, { error: 'args must be a non-empty list of strings, without --session' });
  const timeoutMs = typeof parsed.timeoutMs === 'number' && parsed.timeoutMs > 0 ? Math.min(parsed.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  answer(200, await herdr(o, parsed.args, timeoutMs));
}

/** After the load's answer leaves this end, how long the link stays up for it to reach the hopper before the restart. */
const RESTART_GRACE_MS = 1000;

/** A signed load: the release checked whole, written into the install dir, then — once the answer is on its way — a restart asked for. */
function load(o: ClientOptions, releases: Releases, stream: ServerHttp2Stream, body: string, answer: (status: number, payload: unknown) => void): void {
  let parsed: { release?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { return answer(400, { error: 'body must be JSON' }); }
  const release = checkRelease(parsed.release);
  if (typeof release === 'string') return answer(400, { error: release });
  if (release.id !== releases.installed) {
    installRelease(o.installDir, release);
    releases.installed = release.id;
    o.log?.(`hopper-client: loaded release ${release.id} into ${o.installDir} (running ${releases.running}); restarting`);
  }
  if (release.id !== releases.running) stream.once('close', () => setTimeout(() => o.onLoaded?.(release.id), RESTART_GRACE_MS));
  answer(200, { release: release.id });
}

export function startClient(o: ClientOptions): Client {
  if (o.session === 'default' || !o.session) throw new Error('the client\'s herdr session must be named and never `default`');
  checkToken(o.token());
  const running = readRelease(o.installDir).id;
  const releases: Releases = { running, installed: running };
  const nonces = createNonceCache();
  const log = o.log ?? (() => {});
  const backoff = o.backoffMs ?? BACKOFF_MS;
  let stopped = false;
  let attempt = 0;
  let link: Duplex | undefined;
  let timer: NodeJS.Timeout | undefined;
  let exited: Promise<void> = Promise.resolve();

  const again = (why: string, started: number): void => {
    if (stopped) return;
    if (Date.now() - started > STABLE_MS) attempt = 0;
    const wait = backoff[Math.min(attempt++, backoff.length - 1)]!;
    log(`hopper-client: ${why}; dialing again in ${wait} ms`);
    timer = setTimeout(dial, wait);
  };

  function dial(): void {
    if (stopped) return;
    const started = Date.now();
    let close!: () => void;
    exited = new Promise((r) => { close = r; });
    o.dial().then((socket) => {
      if (stopped) { socket.destroy(); close(); return; }
      link = socket;
      const session = performServerHandshake(socket);
      session.on('stream', (stream, headers) => {
        serve(o, nonces, releases, stream, headers).catch((e: unknown) => {
          log(`hopper-client: ${(e as Error).message}`);
          if (!stream.destroyed) stream.close();
        });
      });
      session.on('error', (e) => log(`hopper-client: link session: ${e.message}`));
      socket.on('error', (e) => log(`hopper-client: link: ${e.message}`));
      socket.once('close', () => {
        link = undefined;
        close();
        again('the link ended', started);
      });
    }, (e: unknown) => {
      close();
      again(`dialing the hopper failed: ${(e as Error).message}`, started);
    });
  }

  dial();
  log(`hopper-client: release ${running}, serving herdr session ${o.session} over its link`);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      link?.destroy();
      await exited;
    },
  };
}

/** The disk this user's home is on (issue #401), for the hopper's warning before it fills; none when it cannot be read. */
function diskOfHome(): { disk?: { freeBytes: number; totalBytes: number } } {
  try {
    const s = statfsSync(homedir());
    return { disk: { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize } };
  } catch {
    return {};
  }
}
