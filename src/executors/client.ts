// The hopper's side of a client target (design.md "Client targets", "Target authentication", "Joining a
// machine", issues #59, #308). The client dials in to the hopper's own URL; the upgraded socket is its
// link (src/machines/links.ts), and the client serves HTTP/2 on it. A herdr call is `POST /herdr` on that
// HTTP/2 session, signed with the client token (src/client/signature.ts); an answer the client did not
// sign is not believed. `POST /release` and `POST /load` are the client release's calls (src/client/
// release.ts, issue #70); `POST /claude` a usage read's claude calls (issue #366). One session per link:
// a client that dials in again is a new link.
import { connect, type ClientHttp2Session } from 'node:http2';
import type { Duplex } from 'node:stream';
import type { ClientRelease } from '../client/release.ts';
import type { DiskReading } from '../domain/machines.ts';
import { diskOf } from '../machines/disk.ts';
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

/** The id of the client release the client target runs, and its home when it says (a client before issue #323 does not). */
export async function clientRunningRelease(t: ClientTransport): Promise<{ release: string; home?: string; disk?: DiskReading }> {
  const { release, home, disk } = await clientCall<{ release?: unknown; home?: unknown; disk?: unknown }>(t, '/release', {}, 15000);
  if (typeof release !== 'string') throw new ClientError(`client ${t.machine}: no release in its answer`);
  // The disk its home is on (issue #401): a client older than this says none.
  const d = disk as { freeBytes?: unknown; totalBytes?: unknown } | undefined;
  const read = d && typeof d.freeBytes === 'number' && typeof d.totalBytes === 'number' ? { disk: diskOf(d.freeBytes, d.totalBytes) } : {};
  return { release, ...(typeof home === 'string' && home.startsWith('/') ? { home } : {}), ...read };
}

/** Loads a client release onto the client target; it restarts to run it. */
export async function loadClientRelease(t: ClientTransport, release: ClientRelease): Promise<void> {
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
        return reject(new ClientError(`client ${t.machine}: the answer on its link did not prove itself (no valid client signature)`));
      }
      if (status !== 200) return reject(new ClientError(`client ${t.machine}: ${status} ${text.slice(0, 200)}`));
      try { resolve(JSON.parse(text) as T); } catch { reject(new ClientError(`client ${t.machine}: answer is not JSON`)); }
    });
    req.on('close', () => { if (!status) reject(new ClientError(`client ${t.machine}: no answer within ${timeoutMs + 5000} ms, or its link closed`)); });
    req.on('error', (e) => reject(new ClientError(`client ${t.machine}: ${e.message}`)));
    req.end(body);
  });
}
