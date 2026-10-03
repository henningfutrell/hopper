import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WRAPPER = join(import.meta.dirname, '../../scripts/hopper-comment');
const TOKEN = 'ghs_secret_token_value';
const MARKER = '<!-- job-hopper:job-1 -->';

interface Recorded { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }
interface Run { code: number | null; stdout: string; stderr: string }

let dir: string;
let server: Server;
let requests: Recorded[];
let apiUrl: string;
let respond: { status: number; body: unknown };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hopper-comment-'));
  requests = [];
  respond = { status: 201, body: { html_url: 'https://github.com/o/r/issues/7#issuecomment-1' } };
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

function tokenFile(over: Record<string, unknown> = {}): string {
  const path = join(dir, 'token.json');
  writeFileSync(path, JSON.stringify({ version: 1, token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), repo: 'o/r', issue: 7, ...over }));
  return path;
}

function baseEnv(file: string): Record<string, string> {
  return { PATH: process.env.PATH ?? '', HOPPER_TOKEN_FILE: file, HOPPER_REPO: 'o/r', HOPPER_ISSUE_NUMBER: '7', HOPPER_COMMENT_MARKER: MARKER, HOPPER_GITHUB_API: apiUrl, HOPPER_TOKEN_WAIT_MS: '1000' };
}

function run(args: string[], env: Record<string, string>, stdin?: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(WRAPPER, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d));
    child.stderr.on('data', (d: Buffer) => (stderr += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });
}

describe('hopper-comment', () => {
  it('posts marker and text with the bearer token and prints the comment url', async () => {
    const r = await run(['hello'], baseEnv(tokenFile()));
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('https://github.com/o/r/issues/7#issuecomment-1');
    expect(requests).toHaveLength(1);
    const q = requests[0]!;
    expect(q.method).toBe('POST');
    expect(q.url).toBe('/repos/o/r/issues/7/comments');
    expect(q.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(q.headers.accept).toBe('application/vnd.github+json');
    expect(q.headers['user-agent']).toBe('job-hopper-hopper-comment');
    expect(q.headers['x-github-api-version']).toBe('2022-11-28');
    expect(JSON.parse(q.body)).toEqual({ body: `${MARKER}\nhello` });
  });

  it('joins args with spaces', async () => {
    await run(['a', 'b', 'c'], baseEnv(tokenFile()));
    expect(JSON.parse(requests[0]!.body).body).toBe(`${MARKER}\na b c`);
  });

  it('reads stdin when there are no args', async () => {
    const r = await run([], baseEnv(tokenFile()), 'from stdin\nline 2\n');
    expect(r.code).toBe(0);
    expect(JSON.parse(requests[0]!.body).body).toBe(`${MARKER}\nfrom stdin\nline 2\n`);
  });

  it('waits for a token file that appears late', async () => {
    const path = join(dir, 'token.json');
    setTimeout(() => tokenFile(), 200);
    const r = await run(['late'], { ...baseEnv(path), HOPPER_TOKEN_WAIT_MS: '5000' });
    expect(r.code).toBe(0);
    expect(requests).toHaveLength(1);
  });

  it('exits 1 when the token file never appears', async () => {
    const r = await run(['x'], { ...baseEnv(join(dir, 'never.json')), HOPPER_TOKEN_WAIT_MS: '300' });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/token file/);
    expect(requests).toHaveLength(0);
  });

  it('refuses an expired token without a request', async () => {
    const r = await run(['x'], baseEnv(tokenFile({ expiresAt: new Date(Date.now() - 1000).toISOString() })));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/expired/);
    expect(requests).toHaveLength(0);
  });

  it('refuses a repo mismatch without a request', async () => {
    const r = await run(['x'], baseEnv(tokenFile({ repo: 'other/repo' })));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/repo/);
    expect(requests).toHaveLength(0);
  });

  it('refuses an issue mismatch without a request', async () => {
    const r = await run(['x'], baseEnv(tokenFile({ issue: 8 })));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/issue/);
    expect(requests).toHaveLength(0);
  });

  for (const status of [403, 500]) {
    it(`exits 1 with the status in stderr on API ${status}`, async () => {
      respond = { status, body: { message: 'nope' } };
      const r = await run(['x'], baseEnv(tokenFile()));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(String(status));
      expect(r.stdout).not.toContain(TOKEN);
    });
  }

  it('truncates the body at 60 000 characters with a note', async () => {
    const r = await run([], baseEnv(tokenFile()), 'z'.repeat(70_000));
    expect(r.code).toBe(0);
    const body: string = JSON.parse(requests[0]!.body).body;
    expect(body.length).toBe(60_000);
    expect(body.startsWith(`${MARKER}\nzzz`)).toBe(true);
    expect(body.endsWith('(truncated)')).toBe(true);
  });

  it('never prints the token', async () => {
    const ok = await run(['x'], baseEnv(tokenFile()));
    respond = { status: 500, body: { message: `bad ${TOKEN}` } };
    const bad = await run(['x'], baseEnv(tokenFile()));
    for (const r of [ok, bad]) {
      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stderr).not.toContain(TOKEN);
    }
  });

  for (const name of ['HOPPER_TOKEN_FILE', 'HOPPER_REPO', 'HOPPER_ISSUE_NUMBER', 'HOPPER_COMMENT_MARKER']) {
    it(`exits 1 naming ${name} when it is unset`, async () => {
      const env = baseEnv(tokenFile());
      delete env[name];
      const r = await run(['x'], env);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(name);
      expect(requests).toHaveLength(0);
    });
  }
});
