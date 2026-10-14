// A tool's sign-in on a machine (issue #1128, design.md "Tool sign-in"): `claude auth login` with its stdin open, its URL read
// from what it prints, the code a person pasted written to it, and its end read. On a client target the client runs its own
// claude, `POST /sign-in`, signed like every call on its link; the argv is the client's own. The client is real; claude is the fake.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeProblem, createSignInRoute, signInArgs, signInUrlIn, startSignIn } from '../../src/client/sign-in.ts';
import { mintToken } from '../../src/client/signature.ts';
import { ClientError, clientSignIn } from '../../src/executors/client.ts';
import { startTestClient, type TestClient } from '../support/client.ts';

const CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude-plan.mjs');
const URL = 'https://claude.com/cai/oauth/authorize?code=true&state=fake';
const TOKEN = mintToken();

let dir: string;
const saved = process.env.FAKE_PLAN_DIR;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'jh-sign-in-'));
  process.env.FAKE_PLAN_DIR = dir;
  writeFileSync(join(dir, 'mode'), 'logged-out');
});
afterEach(() => {
  if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const mode = () => readFileSync(join(dir, 'mode'), 'utf8');
const calls = () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[] });

describe('startSignIn: the tool\'s sign-in with its stdin open', () => {
  it('answers the URL the tool printed; the right code signs it in', async () => {
    const run = await startSignIn(CLAUDE, signInArgs());
    expect(run.url).toBe(URL);
    expect(await run.paste('good-code')).toEqual({ ok: true });
    expect(mode()).toBe('ok');
    expect(calls()[0]!.argv).toEqual(['auth', 'login', '--claudeai']);
  });

  it('a wrong code: the tool\'s own reason, its prompt left out; a second paste is refused', async () => {
    const run = await startSignIn(CLAUDE, signInArgs());
    expect(await run.paste('wrong-code')).toEqual({ ok: false, reason: 'Login failed: Request failed with status code 400' });
    expect(await run.paste('good-code')).toEqual({ ok: false, reason: 'a code was pasted already' });
    expect(mode()).toBe('logged-out');
  });

  it('a tool that ends before it shows a URL: refused with why; a missing tool too', async () => {
    writeFileSync(join(dir, 'mode'), 'login-no-url');
    await expect(startSignIn(CLAUDE, signInArgs())).rejects.toThrow('the sign-in ended before it showed its URL: fake: cannot sign in here');
    await expect(startSignIn('/nonexistent/claude', signInArgs())).rejects.toThrow('not found: /nonexistent/claude');
  });

  it('cancel stops the tool: a paste after it is refused', async () => {
    const run = await startSignIn(CLAUDE, signInArgs());
    run.cancel();
    await new Promise((r) => setTimeout(r, 200));
    expect((await run.paste('good-code')).ok).toBe(false);
    expect(mode()).toBe('logged-out');
  });
});

describe('the sign-in\'s parts', () => {
  it('signInArgs: --email only with an email, never an option', () => {
    expect(signInArgs('ops@example.com')).toEqual(['auth', 'login', '--claudeai', '--email', 'ops@example.com']);
    expect(() => signInArgs('--console')).toThrow('the account must be an email');
    expect(() => signInArgs('a b@example.com')).toThrow();
  });

  it('signInUrlIn: the first https URL, through colours; none yet', () => {
    expect(signInUrlIn(`\x1b[2mvisit:\x1b[0m ${URL}\nPaste code`)).toBe(URL);
    expect(signInUrlIn('Opening browser to sign in…')).toBeUndefined();
  });

  it('codeProblem: one line of printable characters', () => {
    expect(codeProblem('abc#def')).toBeUndefined();
    expect(codeProblem('')).toBeDefined();
    expect(codeProblem('a b')).toBeDefined();
    expect(codeProblem('a\nb')).toBeDefined();
    expect(codeProblem(7)).toBeDefined();
  });

  it('the route: one sign-in at a time; an unknown id is 404; a bad code 400', async () => {
    const route = createSignInRoute((argv) => startSignIn(CLAUDE, argv));
    const first = (await route(JSON.stringify({ act: 'start' }))).payload as { id: string };
    const second = (await route(JSON.stringify({ act: 'start' }))).payload as { id: string; url: string };
    expect(second.url).toBe(URL);
    expect((await route(JSON.stringify({ act: 'paste', id: first.id, code: 'good-code' }))).status).toBe(404);
    expect((await route(JSON.stringify({ act: 'paste', id: second.id, code: 'a b' }))).status).toBe(400);
    expect((await route(JSON.stringify({ act: 'start', email: '--console' }))).status).toBe(400);
    expect((await route('{')).status).toBe(400);
    const third = (await route(JSON.stringify({ act: 'start' }))).payload as { id: string };
    expect(await route(JSON.stringify({ act: 'paste', id: third.id, code: 'good-code' }))).toEqual({ status: 200, payload: { ok: true } });
  });
});

describe('on a client target: POST /sign-in (issue #1128)', () => {
  let client: TestClient | undefined;
  afterEach(async () => { await client?.stop(); client = undefined; });

  it('the client runs its own claude sign-in: its URL, then the code down the same link', async () => {
    client = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: CLAUDE, session: 'hopper' });
    const run = await clientSignIn(client.transport(TOKEN), 'ops@example.com');
    expect(run.url).toBe(URL);
    expect(await run.paste('good-code')).toEqual({ ok: true });
    expect(mode()).toBe('ok');
    expect(calls()[0]!.argv).toEqual(['auth', 'login', '--claudeai', '--email', 'ops@example.com']);
  });

  it('a call the hopper did not sign is refused: claude never runs', async () => {
    client = await startTestClient({ token: () => TOKEN, herdrBin: '/nonexistent/herdr', claudeBin: CLAUDE, session: 'hopper' });
    const wrong = await clientSignIn(client.transport(mintToken())).catch((e: unknown) => e);
    expect(wrong).toBeInstanceOf(ClientError);
    expect(existsSync(join(dir, 'calls.jsonl'))).toBe(false);
  });
});
