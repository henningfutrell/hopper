// A job's scripts carry its trace (issue #1486 part 4, design.md "Telemetry: a job's trace on its machine"): when the job
// runs with `TRACEPARENT`, hopper-gh, hopper-skill, hopper-login, hopper-artifact and hopper-step (part 6) send it as the `traceparent` header,
// so the hopper's span for the request is a child of the job's run span. A value that is not a W3C trace parent (only
// lowercase hex and dashes) is not sent: the variable cannot add a header. The real scripts (sh and curl) run against a
// stand-in on loopback.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_SCRIPT } from '../../src/artifacts/index.ts';
import { PROXY_SCRIPT } from '../../src/github-proxy/index.ts';
import { LOGIN_SCRIPT } from '../../src/logins/script.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { STEP_SCRIPT } from '../../src/windows-steps/index.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A stand-in hopper that answers 200 and keeps the headers of each request. */
async function hopper(): Promise<{ url: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function run(script: string, args: readonly string[], url: string, more: Record<string, string>): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), 'job-trace-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'token'), 'job-token\n', { mode: 0o600 });
  writeFileSync(join(dir, 'script'), script, { mode: 0o700 });
  writeFileSync(join(dir, 'page.html'), '<svg></svg>');
  return new Promise((resolve) => {
    execFile('sh', [join(dir, 'script'), ...args], {
      cwd: dir, env: { PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), TMPDIR: dir, ...more } as NodeJS.ProcessEnv,
    }, (err) => resolve(err ? Number((err as { code?: number }).code ?? 1) : 0));
  });
}

const SCRIPTS = [
  { name: 'hopper-gh', script: PROXY_SCRIPT, args: ['issue', 'view', '1', '--repo', 'o/r'] },
  { name: 'hopper-skill', script: SKILL_SCRIPT, args: [] },
  { name: 'hopper-login', script: LOGIN_SCRIPT, args: ['completed', 'codex'] },
  { name: 'hopper-artifact', script: ARTIFACT_SCRIPT, args: ['put', 'page.html', '--title', 'T', '--summary', 'S'] },
  { name: 'hopper-step', script: STEP_SCRIPT, args: ['hosts'] },
] as const;

const PARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('a job\'s scripts carry its trace (issue #1486)', () => {
  for (const s of SCRIPTS) {
    it(`${s.name}: sends TRACEPARENT as the traceparent header`, async () => {
      const h = await hopper();
      expect(await run(s.script, s.args, h.url, { TRACEPARENT: PARENT })).toBe(0);
      expect(h.seen[0]).toMatchObject({ traceparent: PARENT, authorization: 'Bearer job-token' });
    });

    it(`${s.name}: sends no traceparent when the job has none, or one that is not a trace parent`, async () => {
      const h = await hopper();
      expect(await run(s.script, s.args, h.url, {})).toBe(0);
      expect(await run(s.script, s.args, h.url, { TRACEPARENT: `${PARENT}\nx-added: 1` })).toBe(0);
      expect(await run(s.script, s.args, h.url, { TRACEPARENT: 'NOT A PARENT' })).toBe(0);
      expect(h.seen).toHaveLength(3);
      for (const headers of h.seen) {
        expect(headers.traceparent).toBeUndefined();
        expect(headers['x-added']).toBeUndefined();
      }
    });
  }
});
