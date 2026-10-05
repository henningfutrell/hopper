// gh login from the UI (issue #138, design.md "gh login"): gh's own device flow, run without a
// terminal — `gh auth login --web` prints its device code and waits until the GitHub user approves it
// at github.com/login/device, then stores the token in gh's own config (in a container, the home
// volume). The hopper reads the code from gh's output and keeps nothing. One login at a time.
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import type { GhLogin } from '../../domain/ports.ts';
import type { GhLoginStatus } from '../../domain/types.ts';

const LOGIN_ARGS = ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https'];
const CODE_RE = /one-time code: (\S+)/;
const URI_RE = /(https:\/\/\S+\/login\/device)/;
const ACCOUNT_RE = /Logged in to \S+ (?:account|as) (\S+)/;
const STATUS_TIMEOUT_MS = 10000;
const CODE_TIMEOUT_MS = 20000;
/** gh refuses to log in while a token variable is set: it would keep using the variable. */
const TOKEN_SET = (name: string) => `${name} is set and gh uses it instead of a login: remove it from the hopper's environment (.env) and restart, then log in`;

export interface GhLoginOptions {
  /** The gh CLI, found on the environment's PATH. */
  bin: string;
  env: Record<string, string | undefined>;
  /** How long gh may take to print its device code; default 20 s. */
  codeTimeoutMs?: number;
}

/** gh's last output line, its reason when it fails. */
const lastLine = (out: string, fallback: string) => out.trim().split('\n').at(-1)?.trim() || fallback;

export function createGhLogin(o: GhLoginOptions): GhLogin {
  let child: ChildProcess | undefined;
  let waiting: { userCode: string; verificationUri: string } | undefined;
  let failure: string | undefined;

  const authStatus = () => new Promise<GhLoginStatus>((resolve) => {
    execFile(o.bin, ['auth', 'status'], { env: o.env, timeout: STATUS_TIMEOUT_MS }, (err, stdout, stderr) => {
      if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve({ state: 'unavailable', reason: `gh not found: ${o.bin}` });
      if (err) return resolve(failure ? { state: 'failed', error: failure } : { state: 'logged-out' });
      const account = ACCOUNT_RE.exec(`${stdout}\n${stderr}`)?.[1];
      resolve(account ? { state: 'logged-in', account } : { state: 'logged-in' });
    });
  });

  const status = async (): Promise<GhLoginStatus> => (waiting ? { state: 'waiting', ...waiting } : authStatus());

  function begin(): Promise<GhLoginStatus> {
    failure = undefined;
    const p = spawn(o.bin, LOGIN_ARGS, { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child = p;
    let out = '';
    return new Promise((resolve) => {
      const timer = setTimeout(() => { fail('gh printed no device code'); p.kill(); }, o.codeTimeoutMs ?? CODE_TIMEOUT_MS);
      function fail(error: string) {
        clearTimeout(timer);
        if (child === p) { child = undefined; waiting = undefined; failure = error; }
        console.warn(`hopper: gh login failed: ${error}`);
        resolve({ state: 'failed', error });
      }
      const read = (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const userCode = CODE_RE.exec(out)?.[1];
        const verificationUri = URI_RE.exec(out)?.[1];
        if (!waiting && userCode && verificationUri && child === p) {
          clearTimeout(timer);
          waiting = { userCode, verificationUri };
          console.warn('hopper: gh login waiting for the device code to be approved');
          resolve({ state: 'waiting', ...waiting });
        }
      };
      p.stdout.on('data', read);
      p.stderr.on('data', read);
      p.on('error', (err: NodeJS.ErrnoException) => fail(err.code === 'ENOENT' ? `gh not found: ${o.bin}` : err.message));
      p.on('close', (code) => {
        if (child !== p) return;
        if (code === 0) {
          clearTimeout(timer);
          child = undefined; waiting = undefined;
          console.warn('hopper: gh login done');
          resolve({ state: 'logged-in' });
        } else fail(lastLine(out, `gh exited with ${code}`));
      });
    });
  }

  return {
    status,
    async start() {
      if (waiting) return { state: 'waiting', ...waiting };
      const now = await authStatus();
      if (now.state === 'unavailable' || now.state === 'logged-in') return now;
      const variable = ['GH_TOKEN', 'GITHUB_TOKEN'].find((n) => o.env[n]);
      if (variable) return { state: 'failed', error: TOKEN_SET(variable) };
      return begin();
    },
    async cancel() {
      const p = child;
      child = undefined; waiting = undefined; failure = undefined;
      if (p) { p.kill(); console.warn('hopper: gh login cancelled'); }
      return authStatus();
    },
  };
}
