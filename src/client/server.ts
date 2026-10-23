// The hopper client (design.md "Client targets", issue #59): what a client target runs. It dials in to
// the hopper's own URL (dial.ts, issue #308) and serves HTTP/2 on that link's socket: the hopper sends
// its calls down it. Its routes:
// `POST /herdr {args, timeoutMs?}` runs `<herdrBin> --session <session> <args>` with no shell and
// answers `{code, stdout, stderr}` — the binary and the session are the client's own, never the
// request's; `POST /release` answers `{release, loads, home, disk, resources}`, the id of the release this process runs
// (release.ts, issue #70), `loads: 'manifest'` — it loads any release its manifest vouches for (issue #545; a
// client before that says nothing, and checks a fixed list of file names) — and this user's home, where `~` in a job's work tree resolves (issue #323), the disk it is on (issue #401), the infra credentials its home and environment hold (issues #1128 part 7, #1248, infra-credentials.ts) and this machine's CPU, memory and swap (issue #560, resources.ts), and its client door (issue #695, door.ts); `POST /load {release}` writes the hopper's release into the install dir
// and then asks to be restarted (`onLoaded`; main.ts exits and the unit starts the new files);
// `POST /reap {jobId, scratch?, keep?, discard?}`, `POST /survey {roots}` (reap.ts) and `POST /credential` (issue #441, credential.ts) run fixed
// scripts on this machine (issue #410): the reap of an ended job, what the sweep asks, a running job's token; `{code, stdout, stderr}`;
// `POST /discover` runs the discovery script (issue #542, discover.ts): only reads, no argument of the request's; `{code, stdout, stderr}`;
// `POST /reach {url}` runs the reach check (issue #695, reach.ts): whether this machine reaches the hopper at that URL; `{code, stdout, stderr}`;
// `POST /checkpoint {jobId, worktree, session}` takes a running job's checkpoint (issue #921, checkpoint.ts): it only reads; `{code, stdout, stderr}`;
// `POST /leftovers {roots}` lists what the layout before left in each work tree's .hopper-scratch, and `POST /leftover-remove {path}` removes one leftover a
// person chose to remove (issue #1116, leftovers.ts); `{code, stdout, stderr}`;
// `POST /runtime` carries a container runtime call of the hopper's to this machine's own Podman or Docker, checked (issue #708, runtime.ts);
// a create of a box or a herdr tab sent again is answered with the first answer for its name (issue #1628, once.ts);
// `POST /claude {args, timeoutMs?, token?}` runs `<claudeBin> <args>` for a usage read (issue #366) — only the two
// read-only calls `claude-plan` makes, nothing else, with a lane pod's setup token when it carries one (issue #1287) — with no shell, stdin closed, in a fresh private dir
// removed after with the project dir claude keeps for it, and answers `{code, stdout, stderr}`; `POST /work-tree
// {workTree}` makes the machine's work tree under this user's home, `{workTreeProblem}` when it cannot (issue #361).
// `POST /sign-in {act, …}` runs this machine's claude sign-in (issue #1128, sign-in.ts): `start` answers its URL, `paste` writes the
// code a person pasted and answers how it ended, `cancel` stops it; the argv is built here, the request names only the account.
// `POST /level {model, effort?, jsonSchema, prompt, timeoutMs?}` runs an escalation level's claude in print
// mode the same way (issue #482, level.ts): the argv locked down and built here, the prompt on stdin.
// `POST /turn {script, timeoutMs}` runs a print-mode agent's turn the hopper built (issue #865, turn.ts), its job's runtime and
// sandbox in it; `{code, stdout, stderr, timedOut?}`; the hopper closing the call stops it.
// A request runs only when the hopper signed it with the client's token (signature.ts); every answer
// is signed back. When the link ends, or a dial fails, the client dials again, backing off to 30 s. A dial refused as
// stale waited behind a stall of the hopper's event loop (issue #1154): it is dialled again at the first backoff, signed
// fresh, once; a second stale refusal in a row is a clock that is wrong, and backs off as any failure.
// Each request the hopper signed and each keepalive PING it answers is the hopper heard; cut off from it longer than its
// max isolation, the client stops the jobs the hopper last named in `/release`, and the next `/release` answer says so (issue #752, isolation.ts).
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { serveLink, type PingTiming } from './keepalive.ts';
import { type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { Duplex } from 'node:stream';
import { credentialOf } from './credential.ts';
import { startIsolationWatch, type StartedIsolationWatch } from './isolation.ts';
import { DISCOVER_TIMEOUT_MS, discoverArgv } from './discover.ts';
import { reachOf } from './reach.ts';
import { CHECKPOINT_TIMEOUT_MS, checkpointOf } from './checkpoint.ts';
import { runArgv } from './run.ts';
import { readReap, REAP_TIMEOUT_MS, reapArgv, scriptArgvOf, SURVEY_TIMEOUT_MS } from './reap.ts';
import { leftoverArgvOf, LEFTOVER_REMOVE_TIMEOUT_MS, LEFTOVERS_TIMEOUT_MS } from './leftovers.ts';
import { PRUNE_TIMEOUT_MS, pruneArgvOf } from './prune.ts';
import { defaultRuntimeSockets, runtimeRoute, type RuntimeSockets } from './runtime.ts';
import { level, runClaude } from './level.ts';
import { createSignInRoute, startSignIn } from './sign-in.ts';
import { checkRelease, installRelease, readRelease } from './release.ts';
import { createResourceMeter, diskOfHome } from './resources.ts';
import { infraCredentialsAt } from './infra-credentials.ts';
import type { WindowsLink } from './windows-link.ts';
import { runTurn, turnOf } from './turn.ts';
import { workTreeCall } from './work-tree.ts';
import { createKeyOf, createOnce, type Creates } from './once.ts';
import { REQUEST_HEADER, RESPONSE_HEADER, checkToken, createNonceCache, signResponse, verifyRequest } from './signature.ts';

const MAX_BODY = 1024 * 1024;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15000;
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
/** The hopper's refusal of a dial-in whose signature was older than its window when it was read (dial.ts). */
const STALE_REFUSAL = /refused: stale\b/;
/** A link that stayed up this long starts the backoff over. */
const STABLE_MS = 60000;

export interface ClientOptions {
  /** The client's token, read at each request so a rotated one is used at once. */
  token: () => string;
  /** This machine's herdr binary (absolute) and the session the hopper's jobs run in (never `default`). */
  herdrBin: string;
  session: string;
  /** This machine's claude binary, for a usage read (`POST /claude`) and a level's run (`POST /level`); default `claude` on its PATH. */
  claudeBin?: string;
  /** Dials the hopper once: resolves the link's socket (dial.ts), or rejects. */
  dial: () => Promise<Duplex>;
  log?: (line: string) => void;
  /** Delays between dials; default 1 s, 2 s, 5 s, 10 s, then 30 s. */
  backoffMs?: readonly number[];
  /** The link's keepalive (keepalive.ts, issue #752); default PING_TIMING. */
  ping?: PingTiming;
  /** The directory this client's files are installed in: its release is read from it at start, and a load writes there. */
  installDir: string;
  /** A release was loaded into installDir: restart to run it. Called after the answer is sent. */
  onLoaded?: (release: string) => void;
  /** The vault's helper (vault.ts, issue #558): said in `/release` as `vault`, so the hopper gives each job its path as HOPPER_SECRET. */
  vaultHelper?: string;
  /** The client door's URL (door.ts, issue #695), once it is open: said in `/release` as `door`, so the hopper gives it to each job as HOPPER_URL. */
  door?: () => string | undefined;
  /** Where this machine's own Podman and Docker sockets are (runtime.ts, issue #708); default under its runtime dir. */
  runtimeSockets?: () => RuntimeSockets;
  /** Cut off from the hopper this long, the client stops the jobs the hopper last named (issue #752); 0: never. Default 30 min. */
  maxIsolationMs?: number;
  /** How often it checks how long it has not heard the hopper; default 15 s. */
  isolationCheckMs?: number;
  /** Where the jobs the hopper named are kept, so a restart while cut off still stops them (issue #1627). Absent: memory only. */
  isolationFile?: string;
  /** The Windows link (windows-link.ts, issue #712): said in `/release` with the resources, once tested. */
  windowsLink?: () => WindowsLink | undefined;
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

/**
 * The claude calls a usage read makes (claude-plan): its usage and its account. Zero turns, zero tokens;
 * any other argv is refused, so a signed call can never start a prompt here.
 */
const CLAUDE_CALLS = [
  ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'],
  ['auth', 'status', '--json'],
];

/** What `claude setup-token` prints (src/domain/agent-credential.ts; the client imports nothing of hopper). */
const SETUP_TOKEN = /^sk-ant-oat\d\d-[A-Za-z0-9_-]{8,}$/;

const allowedClaude = (v: unknown): v is string[] =>
  Array.isArray(v) && CLAUDE_CALLS.some((c) => c.length === v.length && c.every((a, i) => a === v[i]));

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
const ROUTES = new Set(['/herdr', '/release', '/load', '/claude', '/level', '/reap', '/survey', '/credential', '/work-tree', '/discover', '/reach', '/checkpoint', '/runtime', '/sign-in', '/leftovers', '/leftover-remove', '/prune', '/turn']);
/** How long a reap or a survey may take: stopping a scope waits up to its 10 s stop timeout. */
const SCRIPT_TIMEOUT_MS = 60000;

/** This machine's CPU, memory and swap (issue #560): each `/release` reads it; CPU busy is over the time since the last. */
const resources = createResourceMeter();

/** The resources with the Windows link, when it was tested. */
const withWindowsLink = <R extends object>(r: R, link: WindowsLink | undefined): R | (R & { windowsLink: WindowsLink }) => (link ? { ...r, windowsLink: link } : r);

/** This machine's claude sign-in (issue #1128): one at a time. */
type SignInRoute = ReturnType<typeof createSignInRoute>;

/** What a client knows of its releases: the one it runs, and the one a load put in its install dir. */
interface Releases { running: string; installed: string }

async function serve(o: ClientOptions, nonces: ReturnType<typeof createNonceCache>, releases: Releases, watch: StartedIsolationWatch, signIn: SignInRoute, creates: Creates, stream: ServerHttp2Stream, headers: IncomingHttpHeaders): Promise<void> {
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
  watch.heard();
  if (path === '/release') return answer(200, { release: releases.running, loads: 'manifest', home: homedir(), ...diskOfHome(), infraCredentials: infraCredentialsAt(homedir()), resources: withWindowsLink(resources(), o.windowsLink?.()), ...(o.vaultHelper ? { vault: o.vaultHelper } : {}), ...(o.door?.() ? { door: o.door() } : {}), ...watch.probed(body) });
  if (path === '/load') return load(o, releases, stream, body, answer);
  if (path === '/reap' || path === '/survey' || path === '/credential' || path === '/work-tree' || path === '/reach' || path === '/checkpoint' || path === '/leftovers' || path === '/leftover-remove' || path === '/prune') return fixed(path, body, answer);
  // Discovery (issue #542): the fixed script, no argument of the request's.
  if (path === '/discover') return answer(200, await runArgv(discoverArgv(), DISCOVER_TIMEOUT_MS));
  if (path === '/level') return level(o.claudeBin ?? 'claude', body, answer);
  if (path === '/sign-in') { const r = await signIn(body); return answer(r.status, r.payload); }
  if (path === '/turn') return turn(stream, body, answer);
  // A create is keyed by the name it makes (issue #1628, once.ts): sent again, it is answered as the first.
  const key = createKeyOf(path, body);
  if (path === '/runtime') {
    const r = await creates(key, () => runtimeRoute(o.runtimeSockets?.() ?? defaultRuntimeSockets(), body), (a) => a.status === 200 && ok((a.payload as { status?: unknown }).status));
    return answer(r.status, r.payload);
  }
  let parsed: { args?: unknown; timeoutMs?: unknown; token?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { return answer(400, { error: 'body must be JSON' }); }
  const timeoutMs = typeof parsed.timeoutMs === 'number' && parsed.timeoutMs > 0 ? Math.min(parsed.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  if (path === '/claude') {
    if (!allowedClaude(parsed.args)) return answer(400, { error: 'args must be one of the claude calls of a usage read' });
    // A lane pod's read (issue #1287): the user's setup token, for this one call, never kept here.
    if (parsed.token !== undefined && (typeof parsed.token !== 'string' || !SETUP_TOKEN.test(parsed.token))) return answer(400, { error: 'token must be what claude setup-token prints' });
    const env = typeof parsed.token === 'string' ? { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: parsed.token } : undefined;
    return answer(200, await runClaude(o.claudeBin ?? 'claude', parsed.args, timeoutMs, '', env));
  }
  if (!validArgs(parsed.args)) return answer(400, { error: 'args must be a non-empty list of strings, without --session' });
  const args = parsed.args;
  answer(200, await creates(key, () => herdr(o, args, timeoutMs), (a) => a.code === 0));
}

const ok = (status: unknown): boolean => typeof status === 'number' && status >= 200 && status < 300;

/**
 * A signed call of a fixed script, run with no shell of the request's: a reap or survey, its argv from the
 * body; a running job's credential (issue #441), its content on stdin; the machine's work tree made (issue #361); the reach check (issue #695); or a checkpoint (issue #921).
 */
async function fixed(path: '/reap' | '/survey' | '/credential' | '/work-tree' | '/reach' | '/checkpoint' | '/leftovers' | '/leftover-remove' | '/prune', body: string, answer: (status: number, payload: unknown) => void): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return answer(400, { error: 'body must be JSON' }); }
  if (path === '/work-tree') { const r = workTreeCall(parsed, homedir()); return answer(r.status, r.payload); }
  // The reach check (issue #695): the fixed script, its one argument a URL.
  // A checkpoint (issue #921): the fixed script, which only reads the job's own worktree and session.
  // The leftovers (issue #1116): the listing only reads; a removal takes one leftover's path in a work tree's .hopper-scratch.
  // The storage prune (issue #2494): an age in days and exited containers by runtime and hex id, checked again there.
  const call = path === '/credential' ? credentialOf(parsed) : path === '/reach' ? reachOf(parsed) : path === '/checkpoint' ? checkpointOf(parsed)
    : path === '/leftovers' || path === '/leftover-remove' ? leftoverArgvOf(path, parsed) : path === '/prune' ? pruneArgvOf(parsed) : scriptArgvOf(path, parsed);
  if (typeof call === 'string') return answer(400, { error: call });
  const timeout = path === '/checkpoint' ? CHECKPOINT_TIMEOUT_MS : path === '/reap' ? REAP_TIMEOUT_MS : path === '/survey' ? SURVEY_TIMEOUT_MS : path === '/leftovers' ? LEFTOVERS_TIMEOUT_MS : path === '/leftover-remove' ? LEFTOVER_REMOVE_TIMEOUT_MS : path === '/prune' ? PRUNE_TIMEOUT_MS : SCRIPT_TIMEOUT_MS;
  answer(200, Array.isArray(call) ? await runArgv(call, timeout) : await runArgv(call.argv, timeout, call.input));
}

/** A print-mode agent's turn (issue #865, turn.ts): stopped when the hopper closes the call or the link ends. */
async function turn(stream: ServerHttp2Stream, body: string, answer: (status: number, payload: unknown) => void): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return answer(400, { error: 'body must be JSON' }); }
  const call = turnOf(parsed);
  if (typeof call === 'string') return answer(400, { error: call });
  const closed = new AbortController();
  stream.once('close', () => closed.abort());
  answer(200, await runTurn(call.script, call.timeoutMs, closed.signal));
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
  const creates = createOnce();
  const signIn = createSignInRoute((argv) => startSignIn(o.claudeBin ?? 'claude', argv, { cwd: homedir() }));
  const log = o.log ?? (() => {});
  const backoff = o.backoffMs ?? BACKOFF_MS;
  let stopped = false;
  let attempt = 0;
  /** The last dial was refused as stale: the next stale refusal backs off. */
  let staleBefore = false;
  let link: Duplex | undefined;
  let timer: NodeJS.Timeout | undefined;
  let exited: Promise<void> = Promise.resolve();
  // Only its scope and processes: not the job's end, so its containers stay for the reap at its end (issue #1120).
  const watch = startIsolationWatch({ ...o, log, stopJob: async (jobId) => {
    const r = await runArgv(reapArgv(jobId, '', true), SCRIPT_TIMEOUT_MS);
    if (!readReap(r.stdout)) throw new Error(`the reap did not finish (${r.code}): ${r.stderr.slice(0, 200)}`);
  } });

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
      staleBefore = false;
      link = socket;
      const session = serveLink(socket, () => { log('hopper-client: the hopper did not answer a PING; the link is dead'); socket.destroy(); }, o.ping, watch.heard);
      session.on('stream', (stream, headers) => {
        serve(o, nonces, releases, watch, signIn, creates, stream, headers).catch((e: unknown) => {
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
      const stale = STALE_REFUSAL.test((e as Error).message);
      if (stale && !staleBefore) attempt = 0;
      staleBefore = stale;
      again(`dialing the hopper failed: ${(e as Error).message}`, started);
    });
  }

  dial();
  log(`hopper-client: release ${running}, serving herdr session ${o.session} over its link`);
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      watch.close();
      link?.destroy();
      await exited;
    },
  };
}

