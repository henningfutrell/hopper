// Issue #752: a job's scripts obey Retry-After. While the hopper is out of reach, the client door holds a job's request,
// then answers 503 with Retry-After; hopper-gh, hopper-skill and hopper-artifact wait as it asks and send the request
// again, a few times, then stop with the door's reason. Nothing else is sent again: a 500 or a 503 with no Retry-After is
// the answer, as before. The real scripts (sh and curl) run against a stand-in on loopback.
//
// Feature: a job's scripts wait while the hopper is out of reach
//   Scenario: a 503 with Retry-After, then the answer: the script waits, sends the request again, and prints the answer
//   Scenario: the hopper stays out of reach: the script stops after a few tries, with the door's reason
//   Scenario: a 500, or a 503 with no Retry-After, is never sent again
//   Scenario: the job is told to keep its local work going and to wait to push while the hopper is out of reach
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_SCRIPT } from '../../src/artifacts/index.ts';
import { PROXY_SCRIPT, RETRY_AFTER_TRIES } from '../../src/github-proxy/index.ts';
import { OUT_OF_REACH_LINE, PROTOCOL_LINES } from '../../src/job-rules/index.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const AWAY = 'the hopper is out of reach since 2026-10-11T10:00:00.000Z; wait, do not sign in another way.\n';

/** A stand-in hopper: the first `n` answers are what `early` writes; after that, 200 with `ok`. */
async function hopper(n: number, early: (res: ServerResponse) => void): Promise<{ url: string; seen: { url: string; body: string; auth?: string }[] }> {
  const seen: { url: string; body: string; auth?: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', body, ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) });
      if (seen.length <= n) return early(res);
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

const away = (wait: string | undefined) => (res: ServerResponse): void => {
  res.writeHead(503, { 'content-type': 'text/plain', ...(wait === undefined ? {} : { 'retry-after': wait }) });
  res.end(AWAY);
};

interface Run { code: number; stdout: string; stderr: string; ms: number }

/** Runs one of the job's scripts as a job does: the script and its token in a credentials dir. */
function run(script: string, args: string[], url: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'job-credentials-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'token'), 'job-token\n', { mode: 0o600 });
  writeFileSync(join(dir, 'script'), script, { mode: 0o700 });
  writeFileSync(join(dir, 'page.html'), '<svg></svg>');
  const started = Date.now();
  return new Promise((resolve) => {
    execFile('sh', [join(dir, 'script'), ...args], {
      cwd: dir, env: { PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), TMPDIR: dir } as NodeJS.ProcessEnv, encoding: 'utf8',
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr, ms: Date.now() - started }));
  });
}

const SCRIPTS = [
  { name: 'hopper-gh', script: PROXY_SCRIPT, args: ['issue', 'view', '1', '--repo', 'o/r'], path: '/job/github', stopped: 1 },
  { name: 'hopper-skill', script: SKILL_SCRIPT, args: [], path: '/job/skill', stopped: 1 },
  { name: 'hopper-artifact', script: ARTIFACT_SCRIPT, args: ['put', 'page.html', '--title', 'T', '--summary', 'S'], path: '/job/artifacts', stopped: 3 },
] as const;

describe('a job\'s scripts obey Retry-After (issue #752)', () => {
  for (const s of SCRIPTS) {
    it(`${s.name}: waits as a 503 with Retry-After asks, sends the request again with its body, and prints the answer`, async () => {
      const h = await hopper(1, away('1'));
      const r = await run(s.script, [...s.args], h.url);
      expect(r).toMatchObject({ code: 0 });
      expect(r.stdout).toContain('ok');
      expect(r.stdout).not.toContain('out of reach');
      expect(r.stderr).toContain('trying again in 1 s');
      expect(r.ms).toBeGreaterThanOrEqual(1000);
      expect(h.seen).toHaveLength(2);
      expect(h.seen[1]).toEqual(h.seen[0]);
      expect(h.seen[0]!.url.startsWith(s.path)).toBe(true);
      expect(h.seen[0]!.auth).toBe('Bearer job-token');
    });

    it(`${s.name}: stops after ${RETRY_AFTER_TRIES} tries while the hopper stays out of reach, with the door's reason`, async () => {
      const h = await hopper(100, away('0'));
      const r = await run(s.script, [...s.args], h.url);
      expect(r.code).toBe(s.stopped);
      expect(r.stdout).toContain('the hopper is out of reach since 2026-10-11T10:00:00.000Z; wait, do not sign in another way.');
      expect(h.seen).toHaveLength(RETRY_AFTER_TRIES);
    });

    it(`${s.name}: never sends again a 500, or a 503 with no Retry-After`, async () => {
      for (const early of [away(undefined), (res: ServerResponse) => { res.writeHead(500); res.end('broke'); }]) {
        const h = await hopper(100, early);
        const r = await run(s.script, [...s.args], h.url);
        expect(r.code).not.toBe(0);
        expect(h.seen).toHaveLength(1);
      }
    });
  }
});

describe('the job\'s protocol while the hopper is out of reach (issue #752)', () => {
  it('says: keep the local work going, wait to push, never sign in another way', () => {
    expect(PROTOCOL_LINES).toContain(OUT_OF_REACH_LINE);
    expect(OUT_OF_REACH_LINE).toContain('the hopper is out of reach since');
    expect(OUT_OF_REACH_LINE).toContain('Keep the local work going: edit, build, test and commit.');
    expect(OUT_OF_REACH_LINE).toContain('Wait to push');
    expect(OUT_OF_REACH_LINE).toContain('Never sign in another way.');
  });
});
