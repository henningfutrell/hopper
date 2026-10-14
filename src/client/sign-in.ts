// A tool's sign-in on a machine (issue #1128, design.md "Tool sign-in"): `claude auth login` started with its stdin open, the
// URL it prints read as the sign-in URL, the code a person pasted from the sign-in page written to its stdin, and its end read
// as signed in or why not. The client serves it as `POST /sign-in` (one sign-in at a time, `signInRoute`); the hopper's
// claude-plan usage source runs it the same way on this machine and on an ssh or container target. The tool keeps its own
// token: nothing here reads, holds or answers one. Imports nothing of hopper: it is installed on the target as plain files.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** How long the tool has to print its URL. */
export const SIGN_IN_URL_MS = 30_000;
/** How long a sign-in waits for its code before it is stopped. */
export const SIGN_IN_LIFE_MS = 15 * 60_000;
/** How long the tool has to end after the code was written. */
export const SIGN_IN_PASTE_MS = 60_000;
/** The most output kept of a sign-in. */
const OUTPUT_CAP = 64 * 1024;

/** How a sign-in ended: signed in, or why not. */
export type SignInEnd = { ok: true } | { ok: false; reason: string };

/** A sign-in that showed its URL and waits for the code. */
export interface SignInRun {
  url: string;
  /** Write the code; resolves when the tool ended. Once only. */
  paste(code: string): Promise<SignInEnd>;
  /** Stop the tool, whatever it does. */
  cancel(): void;
}

/** An account to pre-fill on the sign-in page: an email, never an option. */
const EMAIL = /^[^\s@-][^\s@]{0,127}@[^\s@]{1,126}$/;

/** The sign-in's argv after the tool's binary: `--email` only with an email. */
export function signInArgs(email?: string): string[] {
  if (email !== undefined && !EMAIL.test(email)) throw new Error('the account must be an email');
  return ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])];
}

// eslint-disable-next-line no-control-regex -- the colours a CLI prints are escape sequences
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g;

/** The sign-in URL in what the tool printed: its first https URL; undefined until it shows one. */
export function signInUrlIn(text: string): string | undefined {
  return /https:\/\/[^\s'"<>]+/.exec(text.replace(ANSI, ''))?.[0];
}

/** Why a code cannot be one: a code the page shows is one line of printable characters. */
export function codeProblem(code: unknown): string | undefined {
  if (typeof code !== 'string' || !code.trim()) return 'the code must be text';
  return /^[\x21-\x7e]{1,512}$/.test(code.trim()) ? undefined : 'the code must be one line of at most 512 printable characters, with no spaces';
}

/** Why the tool ended, from what it printed after `from`: its last line, its prompt and the code taken out. */
function reasonOf(output: string, from: number, code: string | undefined, fallback: string): string {
  const lines = output.slice(from).replace(ANSI, '').split(/\r?\n/).map((l) => l.replace(/^.*prompted >\s*/, '').trim()).filter(Boolean);
  const last = lines.at(-1);
  if (!last) return fallback;
  return (code ? last.split(code).join('…') : last).slice(0, 300);
}

/**
 * Start a sign-in: `file argv` with its stdin open. Resolves once it printed its URL; rejects when it ends first, or prints none
 * in `urlMs`. Stopped after `lifeMs` with no code, and `pasteMs` after the code when it has not ended.
 */
export function startSignIn(file: string, argv: string[], o: { cwd?: string; env?: NodeJS.ProcessEnv; urlMs?: number; lifeMs?: number; pasteMs?: number } = {}): Promise<SignInRun> {
  const child = spawn(file, argv, { ...(o.cwd ? { cwd: o.cwd } : {}), ...(o.env ? { env: o.env } : {}), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  let ended: { code: number | null; error?: string } | undefined;
  const onEnd: ((e: { code: number | null; error?: string }) => void)[] = [];
  const end = (e: { code: number | null; error?: string }): void => {
    if (ended) return;
    ended = e;
    clearTimeout(life);
    for (const f of onEnd.splice(0)) f(e);
  };
  const exited = (): Promise<{ code: number | null; error?: string }> => (ended ? Promise.resolve(ended) : new Promise((r) => onEnd.push(r)));
  const kill = (): void => { if (!ended) child.kill('SIGKILL'); };
  const life = setTimeout(kill, o.lifeMs ?? SIGN_IN_LIFE_MS);
  life.unref();
  child.stdin.on('error', () => undefined); // a tool that exits first answers its own exit code
  for (const out of [child.stdout, child.stderr]) out.on('data', (c: Buffer) => { output = (output + c.toString('utf8')).slice(-OUTPUT_CAP); });
  child.on('error', (e: NodeJS.ErrnoException) => end({ code: null, error: e.code === 'ENOENT' ? `not found: ${file}` : e.message }));
  child.on('close', (code) => end({ code }));
  let pasted = false;
  const run = (url: string): SignInRun => ({
    url,
    async paste(code) {
      if (pasted) return { ok: false, reason: 'a code was pasted already' };
      pasted = true;
      if (ended) return { ok: false, reason: `the sign-in ended first: ${reasonOf(output, 0, undefined, 'it stopped')}` };
      const from = output.length;
      child.stdin.write(`${code.trim()}\n`);
      const timer = setTimeout(kill, o.pasteMs ?? SIGN_IN_PASTE_MS);
      const e = await exited();
      clearTimeout(timer);
      if (e.code === 0) return { ok: true };
      return { ok: false, reason: e.error ?? reasonOf(output, from, code.trim(), e.code === null ? 'the sign-in was stopped' : `it exited ${e.code}`) };
    },
    cancel: kill,
  });
  return new Promise((resolve, reject) => {
    const check = (): void => {
      const url = signInUrlIn(output);
      if (!url) return;
      clearTimeout(timer);
      for (const out of [child.stdout, child.stderr]) out.off('data', check);
      resolve(run(url));
    };
    const timer = setTimeout(() => { kill(); reject(new Error(`the sign-in showed no URL in ${(o.urlMs ?? SIGN_IN_URL_MS) / 1000} s`)); }, o.urlMs ?? SIGN_IN_URL_MS);
    for (const out of [child.stdout, child.stderr]) out.on('data', check);
    onEnd.push((e) => {
      clearTimeout(timer);
      if (!signInUrlIn(output)) reject(new Error(`the sign-in ended before it showed its URL: ${e.error ?? reasonOf(output, 0, undefined, `it exited ${e.code}`)}`));
    });
  });
}

/**
 * The client's `POST /sign-in` (issue #1128): `{act: 'start', email?}` starts the machine's claude sign-in — a new one stops the
 * one before — and answers `{id, url}`; `{act: 'paste', id, code}` writes the code and answers how it ended (`SignInEnd`);
 * `{act: 'cancel', id}` stops it. The argv is built here: the request names only the account.
 */
export function createSignInRoute(start: (argv: string[]) => Promise<SignInRun>): (body: string) => Promise<{ status: number; payload: unknown }> {
  let current: { id: string; run: SignInRun } | undefined;
  return async (body) => {
    let b: { act?: unknown; email?: unknown; id?: unknown; code?: unknown };
    try { b = JSON.parse(body) as typeof b; } catch { return { status: 400, payload: { error: 'body must be JSON' } }; }
    if (b.act === 'start') {
      if (b.email !== undefined && typeof b.email !== 'string') return { status: 400, payload: { error: 'email must be text' } };
      let argv: string[];
      try { argv = signInArgs(b.email); } catch (e) { return { status: 400, payload: { error: (e as Error).message } }; }
      current?.run.cancel();
      current = undefined;
      try {
        const run = await start(argv);
        current = { id: randomUUID(), run };
        return { status: 200, payload: { id: current.id, url: run.url } };
      } catch (e) {
        return { status: 200, payload: { error: e instanceof Error ? e.message : String(e) } };
      }
    }
    if (b.act !== 'paste' && b.act !== 'cancel') return { status: 400, payload: { error: 'act must be start, paste or cancel' } };
    if (typeof b.id !== 'string' || b.id !== current?.id) return { status: 404, payload: { error: 'no such sign-in on this machine' } };
    const { run } = current;
    if (b.act === 'cancel') {
      current = undefined;
      run.cancel();
      return { status: 200, payload: { cancelled: true } };
    }
    const problem = codeProblem(b.code);
    if (problem) return { status: 400, payload: { error: problem } };
    current = undefined;
    return { status: 200, payload: await run.paste(b.code as string) };
  };
}
