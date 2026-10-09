// The hopper's side of a client target (design.md "Client targets", "Target authentication", "Joining a
// machine", issues #59, #308). The client dials in to the hopper's own URL; the upgraded socket is its
// link (src/machines/links.ts), and the client serves HTTP/2 on it. A herdr call is `POST /herdr` on that
// HTTP/2 session, signed with the client token (src/client/signature.ts); an answer the client did not
// sign is not believed. `POST /release` and `POST /load` are the client release's calls (src/client/
// release.ts, issue #70); `POST /claude` a usage read's claude calls (issue #366); `POST /level` an escalation
// level's run (issue #482); `POST /reap` and `POST /survey`
// its machine scripts (issue #410). One session per link: a client that dials in again is a new link.
import { DISCOVER_TIMEOUT_MS } from '../client/discover.ts';
import { connect, type ClientHttp2Session } from 'node:http2';
import type { Duplex } from 'node:stream';
import type { ClientRelease } from '../client/release.ts';
import type { FixedListRelease } from '../machines/client-bridge.ts';
import type { DiskReading } from '../domain/machines.ts';
import type { ResourceReading } from '../domain/machine-history.ts';
import { diskOf } from '../machines/disk.ts';
import { resourcesOf } from '../machines/resources.ts';
import { REQUEST_HEADER, RESPONSE_HEADER, checkToken, nonceOf, signRequest, verifyResponse } from '../client/signature.ts';

/** Reaching a client target. */
export interface ClientTransport {
  /** The machine's name in the plugins config. */
  machine: string;
  /** Its link now: the socket it dialled in on; undefined while it is not dialled in. */
  link: () => Duplex | undefined;
  /** The client token, derived from the hopper's link key and the machine key; read at each call. */
  token: () => string;
}

export interface ClientAnswer { code: number; stdout: string; stderr: string }

/** Thrown for anything but an answer the client signed: not connected, refused, or not the client. */
export class ClientError extends Error {}

const sessions = new WeakMap<Duplex, Promise<ClientHttp2Session>>();

/** The HTTP/2 session on the machine's link, opened once per link. */
function sessionOn(t: ClientTransport): Promise<ClientHttp2Session> {
  const link = t.link();
  if (!link || link.destroyed) return Promise.reject(new ClientError(`client ${t.machine} is not dialled in`));
  const open = sessions.get(link);
  if (open) return open;
  const opened = new Promise<ClientHttp2Session>((resolve, reject) => {
    const s = connect('http://hopper-client', { createConnection: () => link });
    s.once('connect', () => resolve(s));
    s.once('error', (e) => reject(new ClientError(`client ${t.machine}: ${e.message}`)));
    s.once('close', () => sessions.delete(link));
  });
  sessions.set(link, opened);
  return opened;
}

/** One herdr call on the client target; resolves the client's signed answer. */
export function clientHerdr(t: ClientTransport, args: string[], timeoutMs: number): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, '/herdr', { args, timeoutMs }, timeoutMs);
}

/** One claude call of a usage read on the client target (issue #366): the client runs its own claude, and only those calls. */
export function clientClaude(t: ClientTransport, args: string[], timeoutMs: number): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, '/claude', { args, timeoutMs }, timeoutMs);
}

/** An escalation level's run on the client target (issue #482): the client runs its own claude, locked down, the prompt on stdin. */
export function clientLevel(t: ClientTransport, call: { model: string; effort?: string; jsonSchema: Record<string, unknown>; prompt: string }, timeoutMs: number): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, '/level', { ...call, timeoutMs }, timeoutMs);
}

/**
 * The id of the client release the client target runs, whether it loads any release its manifest vouches for
 * (`manifest`, issue #545; a client before that checks a fixed list of file names), and its home when it says (a
 * client before issue #323 does not).
 */
export async function clientRunningRelease(t: ClientTransport): Promise<{ release: string; manifest: boolean; home?: string; disk?: DiskReading; resources?: ResourceReading }> {
  const { release, loads, home, disk, resources } = await clientCall<{ release?: unknown; loads?: unknown; home?: unknown; disk?: unknown; resources?: unknown }>(t, '/release', {}, 15000);
  if (typeof release !== 'string') throw new ClientError(`client ${t.machine}: no release in its answer`);
  // The disk its home is on (issue #401): a client older than this says none.
  const d = disk as { freeBytes?: unknown; totalBytes?: unknown } | undefined;
  const read = d && typeof d.freeBytes === 'number' && typeof d.totalBytes === 'number' ? { disk: diskOf(d.freeBytes, d.totalBytes) } : {};
  const at = clientHome(home);
  // Its CPU, memory and swap (issue #560): a client older than this says none.
  const res = resourcesOf(resources);
  return { release, manifest: loads === 'manifest', ...(at ? { home: at } : {}), ...read, ...(res ? { resources: res } : {}) };
}

/**
 * The home a client answered, as `~` in a work tree resolves against it: an absolute POSIX path, or a
 * Windows drive-letter path (issue #365), its `\` made `/` so a work tree under it is one Windows takes.
 * Anything else is no home.
 */
function clientHome(home: unknown): string | undefined {
  if (typeof home !== 'string') return undefined;
  if (home.startsWith('/')) return home;
  return /^[A-Za-z]:[\\/]/.test(home) ? home.replaceAll('\\', '/') : undefined;
}

/** A reap or a survey on the client target (issue #410): the client runs its own fixed script; resolves what it printed and its exit code. */
export function clientScript(t: ClientTransport, path: '/reap' | '/survey' | '/credential' | '/discover', body: Record<string, unknown>): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, path, body, path === '/discover' ? DISCOVER_TIMEOUT_MS + 15000 : 60000);
}

/**
 * Makes the client target's work tree there (issue #361): what is wrong with it, or nothing. Only a
 * client running the hopper's release has the call (`/work-tree`); rejects as any call does.
 */
export async function clientWorkTree(t: ClientTransport, workTree: string): Promise<{ workTreeProblem?: string }> {
  const { workTreeProblem } = await clientCall<{ workTreeProblem?: unknown }>(t, '/work-tree', { workTree }, 15000);
  return typeof workTreeProblem === 'string' ? { workTreeProblem } : {};
}

/** Loads a client release onto the client target — or, for one with a fixed file list, the bridge to it (issue #545); it restarts to run it. */
export async function loadClientRelease(t: ClientTransport, release: ClientRelease | FixedListRelease): Promise<void> {
  await clientCall(t, '/load', { release }, 30000);
}

/** One signed call on the client target; resolves the client's signed answer, parsed. */
async function clientCall<T>(t: ClientTransport, path: string, payload: unknown, timeoutMs: number): Promise<T> {
  let token: string;
  try { token = checkToken(t.token()); } catch (e) { throw new ClientError(`client ${t.machine}: ${(e as Error).message}`); }
  const session = await sessionOn(t);
  const body = JSON.stringify(payload);
  const auth = signRequest(token, 'POST', path, body);
  return new Promise((resolve, reject) => {
    const req = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json', [REQUEST_HEADER]: auth });
    req.setTimeout(timeoutMs + 5000, () => req.close());
    let status = 0;
    let sig: string | undefined;
    let text = '';
    req.on('response', (h) => {
      status = Number(h[':status']);
      const v = h[RESPONSE_HEADER];
      sig = typeof v === 'string' ? v : undefined;
    });
    req.setEncoding('utf8');
    req.on('data', (c: string) => { text += c; });
    req.on('end', () => {
      if (status === 0) return reject(new ClientError(`client ${t.machine}: no answer: its link closed`));
      if (status === 401) return reject(new ClientError(`client ${t.machine} refused the hopper (401): ${text.slice(0, 200)}`));
      if (!verifyResponse(token, sig, nonceOf(auth), status, text)) {
        // A client answers a route it does not know before it reads the signature, so unsigned (issue #545).
        if (sig === undefined && status === 404) return reject(new ClientError(`client ${t.machine} runs an older client release, which has no ${path}: the hopper loads its own release there once no job runs on it`));
        if (sig === undefined) return reject(new ClientError(`client ${t.machine}: the answer on its link did not prove itself: it carries no client signature`));
        return reject(new ClientError(`client ${t.machine}: the answer on its link did not prove itself: its client signature is not this machine's link key's`));
      }
      if (status !== 200) return reject(new ClientError(`client ${t.machine}: ${status} ${text.slice(0, 200)}`));
      try { resolve(JSON.parse(text) as T); } catch { reject(new ClientError(`client ${t.machine}: answer is not JSON`)); }
    });
    req.on('close', () => { if (!status) reject(new ClientError(`client ${t.machine}: no answer within ${timeoutMs + 5000} ms, or its link closed`)); });
    req.on('error', (e) => reject(new ClientError(`client ${t.machine}: ${e.message}`)));
    req.end(body);
  });
}
