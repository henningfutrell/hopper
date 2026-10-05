// The hopper's side of a client target (design.md "Client targets", "Target authentication", issue
// #59). The client dials this machine over ssh; its key's forced command (src/client/relay.ts) opens
// <dataDir>/clients/<machine>.sock and pipes the daemon's one connection to the client, which serves
// HTTP/2 on it: the reverse tunnel. A herdr call is `POST /herdr` on that HTTP/2 session, signed with
// the client's token (src/client/signature.ts); an answer the client did not sign is not believed.
// `POST /release` and `POST /load` are the client release's calls (src/client/release.ts, issue #70).
// One session per socket in this process: the relay takes one connection per tunnel.
import { connect, type ClientHttp2Session } from 'node:http2';
import { connect as connectSocket } from 'node:net';
import { join } from 'node:path';
import type { ClientRelease } from '../client/release.ts';
import { REQUEST_HEADER, RESPONSE_HEADER, checkToken, nonceOf, signRequest, verifyResponse } from '../client/signature.ts';

/** Reaching a client target. */
export interface ClientTransport {
  /** The machine's name in plugins.yaml. */
  machine: string;
  /** The tunnel's socket on this machine. */
  socket: string;
  /** The client's token, from the runtime; read at each call. */
  token: () => string;
}

export interface ClientAnswer { code: number; stdout: string; stderr: string }

const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Where a client target's tunnel opens its socket: `<dataDir>/clients/<machine>.sock`. */
export function clientSocket(dataDir: string, machine: string): string {
  if (!NAME.test(machine)) throw new Error(`bad client target name: ${JSON.stringify(machine)}`);
  return join(dataDir, 'clients', `${machine}.sock`);
}

/** Thrown for anything but an answer the client signed: not connected, refused, or not the client. */
export class ClientError extends Error {}

const sessions = new Map<string, Promise<ClientHttp2Session>>();

/** The HTTP/2 session through the tunnel's socket, opened once and dropped when it ends. */
function sessionOn(t: ClientTransport): Promise<ClientHttp2Session> {
  const open = sessions.get(t.socket);
  if (open) return open;
  const opened = new Promise<ClientHttp2Session>((resolve, reject) => {
    const s = connect('http://job-hopper-client', { createConnection: () => connectSocket(t.socket) });
    const drop = (): void => { if (sessions.get(t.socket) === opened) sessions.delete(t.socket); };
    s.once('connect', () => resolve(s));
    s.once('error', (e: NodeJS.ErrnoException) => {
      drop();
      reject(e.code === 'ENOENT' || e.code === 'ECONNREFUSED'
        ? new ClientError(`client ${t.machine} is not connected (no tunnel at ${t.socket})`)
        : new ClientError(`client ${t.machine}: ${e.message}`));
    });
    s.once('close', drop);
    s.once('goaway', drop);
  });
  sessions.set(t.socket, opened);
  return opened;
}

/** One herdr call on the client target; resolves the client's signed answer. */
export function clientHerdr(t: ClientTransport, args: string[], timeoutMs: number): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, '/herdr', { args, timeoutMs }, timeoutMs);
}

/** The id of the client release the client target runs. */
export async function clientRunningRelease(t: ClientTransport): Promise<string> {
  const { release } = await clientCall<{ release?: unknown }>(t, '/release', {}, 15000);
  if (typeof release !== 'string') throw new ClientError(`client ${t.machine}: no release in its answer`);
  return release;
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
      if (status === 401) return reject(new ClientError(`client ${t.machine} refused the hopper (401): ${text.slice(0, 200)}`));
      if (!verifyResponse(token, sig, nonceOf(auth), status, text)) {
        return reject(new ClientError(`client ${t.machine}: the answer at its tunnel did not prove itself (no valid client signature)`));
      }
      if (status !== 200) return reject(new ClientError(`client ${t.machine}: ${status} ${text.slice(0, 200)}`));
      try { resolve(JSON.parse(text) as T); } catch { reject(new ClientError(`client ${t.machine}: answer is not JSON`)); }
    });
    req.on('close', () => { if (!status) reject(new ClientError(`client ${t.machine}: no answer within ${timeoutMs + 5000} ms, or the tunnel closed`)); });
    req.on('error', (e) => reject(new ClientError(`client ${t.machine}: ${e.message}`)));
    req.end(body);
  });
}
