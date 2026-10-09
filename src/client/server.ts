// The hopper client (design.md "Client targets", issue #59): what a client target runs. It dials in to
// the hopper's own URL (dial.ts, issue #308) and serves HTTP/2 on that link's socket: the hopper sends
// its calls down it. Its routes:
// `POST /herdr {args, timeoutMs?}` runs `<herdrBin> --session <session> <args>` with no shell and
// answers `{code, stdout, stderr}` — the binary and the session are the client's own, never the
// request's; `POST /release` answers `{release, loads, home, disk, resources}`, the id of the release this process runs
// (release.ts, issue #70), `loads: 'manifest'` — it loads any release its manifest vouches for (issue #545; a
// client before that says nothing, and checks a fixed list of file names) — and this user's home, where `~` in a job's work tree resolves (issue #323), the disk it is on (issue #401) and this machine's CPU, memory and swap (issue #560, resources.ts); `POST /load {release}` writes the hopper's release into the install dir
// and then asks to be restarted (`onLoaded`; main.ts exits and the unit starts the new files);
// `POST /reap {jobId, scratch?}`, `POST /survey {roots}` and `POST /credential` (issue #441, credential.ts) run fixed
// scripts on this machine (issue #410): the reap of an ended job, what the sweep asks, a running job's token; `{code, stdout, stderr}`;
// `POST /discover` runs the discovery script (issue #542, discover.ts): only reads, no argument of the request's; `{code, stdout, stderr}`;
// `POST /claude {args, timeoutMs?}` runs `<claudeBin> <args>` for a usage read (issue #366) — only the two
// read-only calls `claude-plan` makes, nothing else — with no shell, stdin closed, in a fresh private dir
// removed after with the project dir claude keeps for it, and answers `{code, stdout, stderr}`; `POST /work-tree
// {workTree}` makes the machine's work tree under this user's home, `{workTreeProblem}` when it cannot (issue #361).
// `POST /level {model, effort?, jsonSchema, prompt, timeoutMs?}` runs an escalation level's claude in print
// mode the same way (issue #482, level.ts): the argv locked down and built here, the prompt on stdin.
// A request runs only when the hopper signed it with the client's token (signature.ts); every answer
// is signed back. When the link ends, or a dial fails, the client dials again, backing off to 30 s.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { execFile } from 'node:child_process';
import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { performServerHandshake, type IncomingHttpHeaders, type ServerHttp2Stream } from 'node:http2';
import type { Duplex } from 'node:stream';
import { credentialOf } from './credential.ts';
import { DISCOVER_TIMEOUT_MS, discoverArgv } from './discover.ts';
import { level, runClaude } from './level.ts';
import { checkRelease, installRelease, readRelease } from './release.ts';
import { createResourceMeter } from './resources.ts';
import { workTreeCall } from './work-tree.ts';
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
  /** This machine's claude binary, for a usage read (`POST /claude`) and a level's run (`POST /level`); default `claude` on its PATH. */
  claudeBin?: string;
  /** Dials the hopper once: resolves the link's socket (dial.ts), or rejects. */
  dial: () => Promise<Duplex>;
  log?: (line: string) => void;
  /** Delays between dials; default 1 s, 2 s, 5 s, 10 s, then 30 s. */
  backoffMs?: readonly number[];
  /** The directory this client's files are installed in: its release is read from it at start, and a load writes there. */
  installDir: string;
  /** A release was loaded into installDir: restart to run it. Called after the answer is sent. */
  onLoaded?: (release: string) => void;
  /** The vault's helper (vault.ts, issue #558): said in `/release` as `vault`, so the hopper gives each job its path as HOPPER_SECRET. */
  vaultHelper?: string;
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
const ROUTES = new Set(['/herdr', '/release', '/load', '/claude', '/level', '/reap', '/survey', '/credential', '/work-tree', '/discover']);
/** How long a reap or a survey may take: stopping a scope waits up to its 10 s stop timeout. */
const SCRIPT_TIMEOUT_MS = 60000;

/** This machine's CPU, memory and swap (issue #560): each `/release` reads it; CPU busy is over the time since the last. */
const resources = createResourceMeter();

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
  if (path === '/release') return answer(200, { release: releases.running, loads: 'manifest', home: homedir(), ...diskOfHome(), resources: resources(), ...(o.vaultHelper ? { vault: o.vaultHelper } : {}) });
  if (path === '/load') return load(o, releases, stream, body, answer);
  if (path === '/reap' || path === '/survey' || path === '/credential' || path === '/work-tree') return fixed(path, body, answer);
  // Discovery (issue #542): the fixed script, no argument of the request's.
  if (path === '/discover') return answer(200, await runArgv(discoverArgv(), DISCOVER_TIMEOUT_MS));
  if (path === '/level') return level(o.claudeBin ?? 'claude', body, answer);
  let parsed: { args?: unknown; timeoutMs?: unknown };
  try { parsed = JSON.parse(body) as typeof parsed; } catch { return answer(400, { error: 'body must be JSON' }); }
  const timeoutMs = typeof parsed.timeoutMs === 'number' && parsed.timeoutMs > 0 ? Math.min(parsed.timeoutMs, MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  if (path === '/claude') {
    if (!allowedClaude(parsed.args)) return answer(400, { error: 'args must be one of the claude calls of a usage read' });
    return answer(200, await runClaude(o.claudeBin ?? 'claude', parsed.args, timeoutMs));
  }
  if (!validArgs(parsed.args)) return answer(400, { error: 'args must be a non-empty list of strings, without --session' });
  answer(200, await herdr(o, parsed.args, timeoutMs));
}

/**
 * A signed call of a fixed script, run with no shell of the request's: a reap or survey, its argv from the
 * body; a running job's credential (issue #441), its content on stdin; or the machine's work tree made (issue #361).
 */
async function fixed(path: '/reap' | '/survey' | '/credential' | '/work-tree', body: string, answer: (status: number, payload: unknown) => void): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return answer(400, { error: 'body must be JSON' }); }
  if (path === '/work-tree') { const r = workTreeCall(parsed, homedir()); return answer(r.status, r.payload); }
  const call = path === '/credential' ? credentialOf(parsed) : scriptArgvOf(path, parsed);
  if (typeof call === 'string') return answer(400, { error: call });
  answer(200, Array.isArray(call) ? await runArgv(call, SCRIPT_TIMEOUT_MS) : await runArgv(call.argv, SCRIPT_TIMEOUT_MS, call.input));
}

function runArgv(argv: string[], timeoutMs: number, input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(argv[0]!, argv.slice(1), { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
      if (e.killed) return resolve({ code: 124, stdout, stderr: `timed out after ${timeoutMs} ms` });
      resolve({ code: typeof e.code === 'number' ? e.code : 127, stdout, stderr: stderr || e.message });
    });
    child.stdin?.on('error', () => undefined); // a script that exits before reading answers its own exit code
    child.stdin?.end(input ?? '');
  });
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

// ---- The reap and the survey (issues #401, #410, design.md "Work tree" → "The reap") ----
// What runs on a job's machine when the job ends, and what the sweep asks of it: fixed POSIX sh scripts,
// run through the machine's own connection (this machine, ssh, or a client target's `/reap` and
// `/survey`), never typed into a pane where Claude may still be. They live here because a client target
// runs them, and a client release is the files in the client's directory.

/** A job id the scripts take: a uuid, or a test's plain name. Never a pattern, a path or an option. */
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
export const isJobId = (id: unknown): id is string => typeof id === 'string' && JOB_ID.test(id);

/** The transient user scope a job's pane shell (or a print agent's turn) runs in, when the machine has systemd. */
export const scopeUnitOf = (jobId: string): string => `hopper-job-${jobId}`;

export const REAP_DONE = 'hopper-reaped';
export const SURVEY_DONE = 'hopper-surveyed';

// $1 the job id, $2 its scratch dir or empty. Run with HOPPER_JOB_ID unset, so neither it nor what it
// starts matches the processes it stops.
const REAP_SCRIPT = [
  'id=$1; s=$2;',
  // The job's scope: every process in it, whatever it did to its environment or session.
  'if command -v systemctl >/dev/null 2>&1; then systemctl --user stop "hopper-job-$id.scope" >/dev/null 2>&1; fi;',
  // Where there is no systemd, or for what left the scope: the processes carrying the job's id.
  'pids() { grep -lzx "HOPPER_JOB_ID=$id" /proc/[0-9]*/environ 2>/dev/null | sed -n "s|^/proc/\\([0-9]*\\)/environ\\$|\\1|p" | grep -vx "$$"; };',
  'if [ -r /proc/self/environ ]; then',
  '  l=$(pids);',
  '  if [ -n "$l" ]; then',
  '    kill -TERM $l 2>/dev/null;',
  '    n=0; while [ $n -lt 30 ] && [ -n "$(pids)" ]; do sleep 0.1; n=$((n+1)); done;',
  '    l=$(pids); [ -n "$l" ] && kill -KILL $l 2>/dev/null;',
  '  fi;',
  'fi;',
  // The job's temp link /tmp/hopper-<job id> (issue #506), only while it points at this scratch dir.
  't=/tmp/hopper-$id; [ -n "$s" ] && [ -L "$t" ] && [ "$(readlink "$t")" = "$s" ] && rm -f "$t";',
  // Only ever this job's own scratch dir: <work tree>/.hopper-scratch/<job id>.
  'case $s in */.hopper-scratch/"$id") ;; *) printf "%s\\n" hopper-reaped; exit 0;; esac;',
  // The job's credentials (issue #441) go whatever else is kept: they are the hopper's, not the job's work.
  'rm -rf "$s/credentials";',
  'repos() { find "$s" -name node_modules -prune -o -name .git -print -prune 2>/dev/null; };',
  // A worktree (.git a file) answers for its own HEAD; a clone for HEAD and every branch it has. A
  // node_modules link to the shared dependencies (issue #410) is no work of the job's.
  'kept=$(repos | while IFS= read -r g; do',
  '  d=${g%/.git}; r="HEAD --branches"; [ -f "$g" ] && r=HEAD;',
  '  if ! st=$(git -C "$d" status --porcelain 2>/dev/null) || [ -n "$(printf "%s\\n" "$st" | grep -vx "?? node_modules")" ] || ! un=$(git -C "$d" log --oneline -1 $r --not --remotes 2>/dev/null) || [ -n "$un" ]; then',
  '    printf "hopper-kept %s\\n" "$d";',
  '  fi;',
  'done);',
  'if [ -n "$kept" ]; then printf "%s\\n" "$kept"; elif [ -d "$s" ]; then',
  '  repos | while IFS= read -r g; do',
  '    [ -f "$g" ] || continue; d=${g%/.git};',
  '    [ -L "$d/node_modules" ] && rm -f "$d/node_modules";',
  // Never --force: it is clean and pushed, so git removes it and its repository keeps no entry.
  '    c=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) && git --git-dir="$c" worktree remove "$d" 2>/dev/null;',
  '  done;',
  '  rm -rf "$s";',
  'fi;',
  'printf "%s\\n" hopper-reaped',
].map((l) => l.trim()).join(' ');

// $@ the work trees whose scratch dirs to list. What it prints, one per line: the jobs with a scope, the
// jobs with a process carrying their id, and each scratch dir with its age in seconds.
const SURVEY_SCRIPT = [
  'if command -v systemctl >/dev/null 2>&1; then',
  '  systemctl --user list-units --type=scope --plain --no-legend "hopper-job-*" 2>/dev/null | sed -n "s/^hopper-job-\\([^ ]*\\)\\.scope .*/hopper-scope \\1/p";',
  'fi;',
  'if [ -r /proc/self/environ ]; then',
  '  for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" 2>/dev/null < "$f" | sed -n "s/^HOPPER_JOB_ID=//p"; done | sort -u | sed "s/^/hopper-proc /";',
  'fi;',
  'now=$(date +%s);',
  'for r in "$@"; do for d in "$r"/.hopper-scratch/*; do',
  '  [ -d "$d" ] && [ ! -L "$d" ] || continue;',
  '  m=$(stat -c %Y "$d" 2>/dev/null || stat -f %m "$d" 2>/dev/null) || continue;',
  '  printf "hopper-dir %s %s\\n" "$((now - m))" "$d";',
  'done; done;',
  'printf "%s\\n" hopper-surveyed',
].map((l) => l.trim()).join(' ');

/** The argv that reaps a job on the machine it runs on: its scope and processes stopped, its scratch dir (when given) removed unless it holds work. */
export const reapArgv = (jobId: string, scratch = ''): string[] => ['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', REAP_SCRIPT, 'sh', jobId, scratch];

/** The argv that lists what jobs left on the machine: scopes, processes, and the scratch dirs under `roots`. */
export const surveyArgv = (roots: readonly string[]): string[] => ['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', SURVEY_SCRIPT, 'sh', ...roots];

/** What a finished reap said: the repositories it kept. Undefined when it did not finish. */
export function readReap(stdout: string): { kept: string[] } | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(REAP_DONE)) return undefined;
  return { kept: [...new Set(lines.filter((l) => l.startsWith('hopper-kept ')).map((l) => l.slice('hopper-kept '.length)))] };
}

/** One scratch dir the survey found: its job, path and age. */
export interface SurveyedDir { jobId: string; path: string; ageMs: number }
/** What a finished survey found. Undefined when it did not finish. */
export interface Survey { scopes: string[]; processes: string[]; scratch: SurveyedDir[] }

export function readSurvey(stdout: string): Survey | undefined {
  const lines = stdout.split('\n').map((l) => l.trimEnd());
  if (!lines.includes(SURVEY_DONE)) return undefined;
  const ids = (prefix: string): string[] => [...new Set(lines.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length)).filter(isJobId))];
  const scratch: SurveyedDir[] = [];
  for (const l of lines) {
    const m = /^hopper-dir (\d+) (\/.*\/\.hopper-scratch\/([^/]+))$/.exec(l);
    if (m && isJobId(m[3])) scratch.push({ jobId: m[3]!, path: m[2]!, ageMs: Number(m[1]) * 1000 });
  }
  return { scopes: ids('hopper-scope '), processes: ids('hopper-proc '), scratch };
}

/** A scratch dir a reap may name: absolute, one line, and the job's own. */
export const isScratchOf = (path: unknown, jobId: string): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && path.endsWith(`/.hopper-scratch/${jobId}`);

/** A work tree a survey may list under: absolute and one line. */
const isRoot = (path: unknown): path is string => typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && path.length <= 4096;

/** The argv a `/reap` or `/survey` body asks for; else why it is refused. */
export function scriptArgvOf(path: '/reap' | '/survey', body: unknown): string[] | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { jobId?: unknown; scratch?: unknown; roots?: unknown };
  if (path === '/survey') {
    if (!Array.isArray(b.roots) || b.roots.length > 256 || !b.roots.every(isRoot)) return 'roots must be at most 256 absolute paths';
    return surveyArgv(b.roots);
  }
  if (!isJobId(b.jobId)) return 'jobId must be a job id';
  if (b.scratch !== undefined && !isScratchOf(b.scratch, b.jobId)) return 'scratch must be the job\'s own scratch dir';
  return reapArgv(b.jobId, b.scratch);
}
