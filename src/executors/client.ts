// The hopper's side of a client target (design.md "Client targets", "Target authentication", "Joining a
// machine", issues #59, #308). The client dials in to the hopper's own URL; the upgraded socket is its
// link (src/machines/links.ts), and the client serves HTTP/2 on it. A herdr call is `POST /herdr` on that
// HTTP/2 session, signed with the client token (src/client/signature.ts); an answer the client did not
// sign is not believed. `POST /release` and `POST /load` are the client release's calls (src/client/
// release.ts, issue #70); `POST /claude` a usage read's claude calls (issue #366); `POST /level` an escalation
// level's run (issue #482); `POST /reap` and `POST /survey`
// its machine scripts (issue #410); `POST /runtime` a container runtime call on the machine's own runtime (issue #708); `POST /turn` a print-mode agent's turn (issue #865). One session per link: a client that dials in again is a new link.
import { DISCOVER_TIMEOUT_MS } from '../client/discover.ts';
import { CHECKPOINT_TIMEOUT_MS } from '../client/checkpoint.ts';
import { REAP_TIMEOUT_MS, SURVEY_TIMEOUT_MS } from '../client/reap.ts';
import { LEFTOVER_REMOVE_TIMEOUT_MS, LEFTOVERS_TIMEOUT_MS } from '../client/leftovers.ts';
import { PRUNE_TIMEOUT_MS } from '../client/prune.ts';
import { infraCredentialsOf } from '../client/infra-credentials.ts';
import { SIGN_IN_PASTE_MS, SIGN_IN_URL_MS, type SignInRun } from '../client/sign-in.ts';
import { connect, type ClientHttp2Session } from 'node:http2';
import type { Duplex } from 'node:stream';
import type { IsolationStop } from '../client/isolation.ts';
import type { ClientRelease } from '../client/release.ts';
import type { FixedListRelease } from '../machines/client-bridge.ts';
import type { DiskReading } from '../domain/machines.ts';
import type { RuntimeAnswer, RuntimeRelay, RuntimeRelayCall } from '../domain/sandboxes.ts';
import type { ResourceReading } from '../domain/machine-history.ts';
import { diskOf } from '../machines/disk.ts';
import { resourcesOf } from '../machines/resources.ts';
import { keepAlive, type PingTiming } from '../client/keepalive.ts';
import { REQUEST_HEADER, RESPONSE_HEADER, checkToken, nonceOf, signRequest, verifyResponse } from '../client/signature.ts';

/** Reaching a client target. */
export interface ClientTransport {
  /** The machine's name in the plugins config. */
  machine: string;
  /** Its link now: the socket it dialled in on; undefined while it is not dialled in. */
  link: () => Duplex | undefined;
  /** The client token, derived from the hopper's link key and the machine key; read at each call. */
  token: () => string;
  /** The link's keepalive (src/client/keepalive.ts, issue #752); default PING_TIMING. */
  ping?: PingTiming;
}

export interface ClientAnswer { code: number; stdout: string; stderr: string }

/** Thrown for anything but an answer the client signed: not connected, refused, or not the client. */
export class ClientError extends Error {}

const sessions = new WeakMap<Duplex, Promise<ClientHttp2Session>>();
/** Who is told of each machine's missed heartbeats (issue #1569), by the machine's name: a link that dials in again keeps them. */
const lateListeners = new Map<string, Set<() => void>>();

/** Calls `fn` at each missed heartbeat of the machine's link (src/client/keepalive.ts); returns the call that stops it. */
export function onClientLinkLate(t: ClientTransport, fn: () => void): () => void {
  const set = lateListeners.get(t.machine) ?? new Set();
  lateListeners.set(t.machine, set);
  set.add(fn);
  return () => {
    set.delete(fn);
    if (!set.size && lateListeners.get(t.machine) === set) lateListeners.delete(t.machine);
  };
}

const saidLate = (machine: string): void => {
  for (const fn of [...lateListeners.get(machine) ?? []]) {
    try { fn(); } catch (e) { console.warn(`client ${machine}: a missed heartbeat's listener failed: ${(e as Error).message}`); }
  }
};

/** The HTTP/2 session on the machine's link, opened once per link. */
function sessionOn(t: ClientTransport): Promise<ClientHttp2Session> {
  const link = t.link();
  if (!link || link.destroyed) return Promise.reject(new ClientError(`client ${t.machine} is not dialled in`));
  const open = sessions.get(link);
  if (open) return open;
  const opened = new Promise<ClientHttp2Session>((resolve, reject) => {
    const s = connect('http://hopper-client', { createConnection: () => link });
    s.once('connect', () => {
      // A dead or half-open link is dropped within seconds (issue #752): the machine is then not dialled in.
      keepAlive(s, () => { console.warn(`client ${t.machine}: no answer to a PING; dropping its link`); link.destroy(); }, t.ping, undefined, () => saidLate(t.machine));
      resolve(s);
    });
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

/**
 * One claude call of a usage read on the client target (issue #366): the client runs its own claude, and only those calls.
 * `token`: a lane pod's setup token (issue #1287), which that one call runs with as `CLAUDE_CODE_OAUTH_TOKEN`.
 */
export function clientClaude(t: ClientTransport, args: string[], timeoutMs: number, token?: string): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, '/claude', { args, timeoutMs, ...(token ? { token } : {}) }, timeoutMs);
}

/**
 * The claude sign-in on the client target (issue #1128, src/client/sign-in.ts): the client starts it and answers its URL; the code
 * a person pasted goes down the same link, and the client answers how it ended. Throws when it cannot start.
 */
export async function clientSignIn(t: ClientTransport, email?: string): Promise<SignInRun> {
  const started = await clientCall<{ id?: unknown; url?: unknown; error?: unknown }>(t, '/sign-in', { act: 'start', ...(email ? { email } : {}) }, SIGN_IN_URL_MS);
  if (typeof started.error === 'string') throw new ClientError(`client ${t.machine}: ${started.error}`);
  if (typeof started.id !== 'string' || typeof started.url !== 'string') throw new ClientError(`client ${t.machine}: no sign-in in its answer`);
  const id = started.id;
  return {
    url: started.url,
    async paste(code) {
      try {
        const r = await clientCall<{ ok?: unknown; reason?: unknown }>(t, '/sign-in', { act: 'paste', id, code }, SIGN_IN_PASTE_MS);
        return r.ok === true ? { ok: true } : { ok: false, reason: typeof r.reason === 'string' ? r.reason : 'the client gave no reason' };
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) };
      }
    },
    cancel() { clientCall(t, '/sign-in', { act: 'cancel', id }, 15000).catch(() => undefined); },
  };
}

/** An escalation level's run on the client target (issue #482): the client runs its own claude, locked down, the prompt on stdin. */
export function clientLevel(t: ClientTransport, call: { model: string; effort?: string; jsonSchema: Record<string, unknown>; prompt: string }, timeoutMs: number): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, '/level', { ...call, timeoutMs }, timeoutMs);
}

/**
 * The id of the client release the client target runs, whether it loads any release its manifest vouches for
 * (`manifest`, issue #545; a client before that checks a fixed list of file names), and its home when it says (a
 * client before issue #323 does not). `jobs`: the jobs running there, which the client stops when cut off from the
 * hopper too long; its answer says the jobs it stopped so (issue #752).
 */
export async function clientRunningRelease(t: ClientTransport, jobs: readonly string[]): Promise<{ release: string; manifest: boolean; home?: string; disk?: DiskReading; resources?: ResourceReading; infraCredentials?: string[]; vault?: string; door?: string; isolationStops?: IsolationStop[] }> {
  const { release, loads, home, disk, resources, infraCredentials, vault, door, isolationStops } = await clientCall<{ release?: unknown; loads?: unknown; home?: unknown; disk?: unknown; resources?: unknown; infraCredentials?: unknown; vault?: unknown; door?: unknown; isolationStops?: unknown }>(t, '/release', { jobs }, 15000);
  if (typeof release !== 'string') throw new ClientError(`client ${t.machine}: no release in its answer`);
  // The disk its home is on (issue #401): a client older than this says none.
  const d = disk as { freeBytes?: unknown; totalBytes?: unknown } | undefined;
  const read = d && typeof d.freeBytes === 'number' && typeof d.totalBytes === 'number' ? { disk: diskOf(d.freeBytes, d.totalBytes) } : {};
  const at = clientHome(home);
  // Its CPU, memory and swap (issue #560): a client older than this says none.
  const res = resourcesOf(resources);
  // The infra credentials its job user holds (issues #1128 part 7, #1248): only names on the list; a client older than this says none.
  const creds = infraCredentialsOf(infraCredentials);
  // Its vault's helper (issue #558): an absolute path, one line; a client older than this says none.
  const helper = typeof vault === 'string' && vault.startsWith('/') && !/[\n\0]/.test(vault) && vault.length <= 4096 ? { vault } : {};
  // Its client door (issue #695): a loopback URL there; a client older than this says none.
  const open = typeof door === 'string' && /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(door) ? { door } : {};
  const stops = isolationStopsOf(isolationStops);
  return { release, manifest: loads === 'manifest', ...(at ? { home: at } : {}), ...read, ...(res ? { resources: res } : {}), ...(creds ? { infraCredentials: creds } : {}), ...helper, ...open, ...(stops.length ? { isolationStops: stops } : {}) };
}

/** The isolation stops a client said (issue #752): each a job id, a time and a duration; anything else is dropped. */
function isolationStopsOf(v: unknown): IsolationStop[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 100).flatMap((x: { jobId?: unknown; at?: unknown; cutOffMs?: unknown }) =>
    typeof x?.jobId === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(x.jobId) && typeof x.at === 'string' && !Number.isNaN(Date.parse(x.at)) && typeof x.cutOffMs === 'number' && x.cutOffMs >= 0
      ? [{ jobId: x.jobId, at: new Date(x.at).toISOString(), cutOffMs: x.cutOffMs }] : []);
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
export function clientScript(t: ClientTransport, path: '/reap' | '/survey' | '/credential' | '/discover' | '/reach' | '/checkpoint' | '/leftovers' | '/leftover-remove' | '/prune', body: Record<string, unknown>): Promise<ClientAnswer> {
  return clientCall<ClientAnswer>(t, path, body, path === '/discover' ? DISCOVER_TIMEOUT_MS + 15000 : path === '/checkpoint' ? CHECKPOINT_TIMEOUT_MS + 15000 : path === '/reap' ? REAP_TIMEOUT_MS + 15000 : path === '/survey' ? SURVEY_TIMEOUT_MS + 15000
    : path === '/leftovers' ? LEFTOVERS_TIMEOUT_MS + 15000 : path === '/leftover-remove' ? LEFTOVER_REMOVE_TIMEOUT_MS + 15000 : path === '/prune' ? PRUNE_TIMEOUT_MS + 15000 : 60000);
}

/**
 * Makes the client target's work tree there (issue #361): what is wrong with it, or nothing. Only a
 * client running the hopper's release has the call (`/work-tree`); rejects as any call does.
 */
export async function clientWorkTree(t: ClientTransport, workTree: string): Promise<{ workTreeProblem?: string }> {
  const { workTreeProblem } = await clientCall<{ workTreeProblem?: unknown }>(t, '/work-tree', { workTree }, 15000);
  return typeof workTreeProblem === 'string' ? { workTreeProblem } : {};
}

/** Which container runtime the client target has (issue #708): `{kind}`, or `{problem}`, what to do to give it one. */
export async function clientRuntimeWhich(t: ClientTransport): Promise<{ kind: 'podman' | 'docker' } | { problem: string }> {
  const r = await clientCall<{ kind?: unknown; problem?: unknown }>(t, '/runtime', { which: true }, 15000);
  if (r.kind === 'podman' || r.kind === 'docker') return { kind: r.kind };
  return { problem: typeof r.problem === 'string' ? r.problem : 'its client names no container runtime' };
}

/** One container runtime call on the client target's own runtime (issue #708): its runtime's answer. */
export async function clientRuntimeCall(t: ClientTransport, call: RuntimeRelayCall): Promise<RuntimeAnswer> {
  const r = await clientCall<{ status?: unknown; text?: unknown; base64?: unknown }>(t, '/runtime', call, call.timeoutMs ?? 30000);
  if (typeof r.status !== 'number' || typeof r.text !== 'string') throw new ClientError(`client ${t.machine}: its runtime answer has no status`);
  return { status: r.status, text: r.text, ...(typeof r.base64 === 'string' ? { base64: r.base64 } : {}) };
}

/** The relay a remote runtime (src/sandbox/remote.ts) drives the client target's own runtime through. */
export const runtimeRelay = (t: ClientTransport): RuntimeRelay => ({ which: () => clientRuntimeWhich(t), call: (c) => clientRuntimeCall(t, c) });

/**
 * A print-mode agent's turn on the client target (issue #865, src/client/turn.ts): the client runs the script the hopper
 * built for it and answers what it printed, `timedOut` when it ran out `timeoutMs`. Aborting closes the call, and the
 * client stops the turn; the promise then rejects.
 */
export async function clientTurn(t: ClientTransport, script: string, timeoutMs: number, signal: AbortSignal): Promise<ClientAnswer & { timedOut?: boolean }> {
  const r = await clientCall<{ code?: unknown; stdout?: unknown; stderr?: unknown; timedOut?: unknown }>(t, '/turn', { script, timeoutMs }, timeoutMs, signal);
  if (typeof r.code !== 'number' || typeof r.stdout !== 'string' || typeof r.stderr !== 'string') throw new ClientError(`client ${t.machine}: its turn answer has no exit code`);
  return { code: r.code, stdout: r.stdout, stderr: r.stderr, ...(r.timedOut === true ? { timedOut: true } : {}) };
}

/** Loads a client release onto the client target — or, for one with a fixed file list, the bridge to it (issue #545); it restarts to run it. */
export async function loadClientRelease(t: ClientTransport, release: ClientRelease | FixedListRelease): Promise<void> {
  await clientCall(t, '/load', { release }, 30000);
}

/** One signed call on the client target; resolves the client's signed answer, parsed. */
async function clientCall<T>(t: ClientTransport, path: string, payload: unknown, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let token: string;
  try { token = checkToken(t.token()); } catch (e) { throw new ClientError(`client ${t.machine}: ${(e as Error).message}`); }
  const session = await sessionOn(t);
  const body = JSON.stringify(payload);
  const auth = signRequest(token, 'POST', path, body);
  return new Promise((resolve, reject) => {
    const req = session.request({ ':method': 'POST', ':path': path, 'content-type': 'application/json', [REQUEST_HEADER]: auth });
    req.setTimeout(timeoutMs + 5000, () => req.close());
    if (signal) {
      const abort = (): void => { req.close(); reject(new ClientError(`client ${t.machine}: aborted`)); };
      if (signal.aborted) abort();
      signal.addEventListener('abort', abort, { once: true });
      req.once('close', () => signal.removeEventListener('abort', abort));
    }
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
