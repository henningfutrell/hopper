// Issue #2622 part 3: `hopper-heavy`, the client a job's heavy step runs through (`sh "$HOPPER_HEAVY" <command>`, or a
// shim on its PATH). It asks the hopper for a slot, waits while the hopper says why it must, runs the command with its
// slot renewed, and lets the slot go when the command ends. A hopper it cannot ask never stops the command. The real
// script runs against a stand-in hopper on loopback.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HEAVY_CLIENT, HEAVY_CLIENT_FILE, HEAVY_SCRIPT, HEAVY_SCRIPT_FILE } from '../../src/github-proxy/heavy-script.ts';

const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => { s.closeAllConnections(); s.close(r); });
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Seen { op: string; argv?: string[]; slot?: string; auth?: string }

/** A stand-in hopper: answers each `POST /job/heavy` by `answer`, by the request's op and how many came before. */
async function hopper(answer: (call: Seen, n: number) => { status?: number; body: unknown }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      const call = { ...(JSON.parse(body || '{}') as Seen), ...(req.headers.authorization ? { auth: req.headers.authorization } : {}) };
      seen.push(call);
      const a = answer(call, seen.filter((s) => s.op === call.op).length);
      res.writeHead(a.status ?? 200, { 'content-type': typeof a.body === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof a.body === 'string' ? a.body : JSON.stringify(a.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, seen };
}

interface Run { code: number; stdout: string; stderr: string }

/** Runs the script as a job does: it and its client in a credentials dir, beside the job's token. */
function heavy(args: string[], url: string, env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-heavy-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'hopper'), { recursive: true });
  writeFileSync(join(dir, HEAVY_SCRIPT_FILE), HEAVY_SCRIPT);
  writeFileSync(join(dir, HEAVY_CLIENT_FILE), HEAVY_CLIENT);
  writeFileSync(join(dir, 'token'), 'the-job-token\n');
  return new Promise((resolve) => {
    execFile('sh', [join(dir, HEAVY_SCRIPT_FILE), ...args], {
      env: { PATH: process.env.PATH, HOPPER_URL: url, HOPPER_TOKEN_FILE: join(dir, 'token'), ...env },
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

describe('hopper-heavy (issue #2622 part 3)', () => {
  it('waits while the hopper says why, then runs the command with its slot, renews it, and lets it go at the end', async () => {
    const h = await hopper((call, n) => (call.op !== 'take' ? { body: { ok: true } }
      : n === 1 ? { body: { wait: 'local runs 2 JVM builds, and holds at most 2 at once', retryS: 1 } } : { body: { slot: 's1', renewS: 1 } }));
    const r = await heavy(['sh', '-c', 'echo "built $HOPPER_HEAVY_HELD"; sleep 1.5; exit 3'], h.url);
    expect(r.code).toBe(3);
    expect(r.stdout).toBe('built 1\n');
    expect(r.stderr).toContain('hopper-heavy: sh waits: local runs 2 JVM builds, and holds at most 2 at once');
    expect(h.seen.map((s) => s.op).filter((op) => op === 'take')).toEqual(['take', 'take']);
    expect(h.seen[0]).toMatchObject({ argv: ['sh', '-c', 'echo "built $HOPPER_HEAVY_HELD"; sleep 1.5; exit 3'], auth: 'Bearer the-job-token' });
    expect(h.seen.filter((s) => s.op === 'renew').length).toBeGreaterThanOrEqual(1);
    expect(h.seen.at(-1)).toMatchObject({ op: 'release', slot: 's1' });
  });

  it('a command that is no heavy step runs at once, and nothing is let go', async () => {
    const h = await hopper(() => ({ body: { light: 'npm run lint is no heavy step' } }));
    const r = await heavy(['sh', '-c', 'echo linted'], h.url);
    expect(r).toMatchObject({ code: 0, stdout: 'linted\n', stderr: '' });
    expect(h.seen.map((s) => s.op)).toEqual(['take']);
  });

  it('a hopper that says no, or cannot be reached, never stops the command: it runs, and the job is told', async () => {
    const no = await hopper(() => ({ status: 401, body: 'no: job j1 is done, not at work\n' }));
    const r = await heavy(['sh', '-c', 'exit 0'], no.url);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('hopper-heavy: no slot (the hopper said no: job j1 is done, not at work): sh runs now');
    const gone = await heavy(['sh', '-c', 'echo ran'], 'http://127.0.0.1:9/');
    expect(gone).toMatchObject({ code: 0, stdout: 'ran\n' });
    expect(gone.stderr).toContain('hopper-heavy: no slot (the hopper cannot be reached');
  });

  it('inside a heavy step, a heavy command runs as it is: it holds its step\'s slot already', async () => {
    const h = await hopper(() => ({ body: { slot: 's1', renewS: 1 } }));
    const r = await heavy(['sh', '-c', 'echo nested'], h.url, { HOPPER_HEAVY_HELD: '1' });
    expect(r).toMatchObject({ code: 0, stdout: 'nested\n' });
    expect(h.seen).toEqual([]);
  });

  it('with no command it says how to use it', async () => {
    const h = await hopper(() => ({ body: {} }));
    const r = await heavy([], h.url);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('usage: sh "$HOPPER_HEAVY" COMMAND [ARGS...]');
  });
});

// Issue #2622 part 5: under memory pressure the hopper's renew answer says to pause the step; the client stops the
// command's whole process group (SIGSTOP), keeps its slot, and lets it go on (SIGCONT) at the first renew with no pause.
describe('hopper-heavy pauses its step under memory pressure (issue #2622 part 5)', () => {
  it('stops the command while the hopper says pause, and lets it go on after', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hopper-heavy-pause-'));
    dirs.push(dir);
    const states: string[] = [];
    const state = (): string => { try { return readFileSync(`/proc/${readFileSync(join(dir, 'pid'), 'utf8').trim()}/stat`, 'utf8').split(') ')[1]![0]!; } catch { return '?'; } };
    const h = await hopper((call, n) => {
      if (call.op === 'take') return { body: { slot: 's1', renewS: 0.4 } };
      if (call.op !== 'renew') return { body: { ok: true } };
      states.push(state());
      return { body: n <= 2 ? { ok: true, pause: 'local is under memory pressure: 1.5 GiB available, under 2 GiB: the newest heavy step is paused until it clears' } : { ok: true } };
    });
    // The command's child, not the command itself: the whole group stops.
    const r = await heavy(['sh', '-c', `sleep 30 & echo $! > ${join(dir, 'pid')}; i=0; while [ $i -lt 25 ]; do sleep 0.1; i=$((i+1)); done; kill $!; echo done`], h.url);
    expect(r).toMatchObject({ code: 0, stdout: 'done\n' });
    expect(r.stderr).toContain('hopper-heavy: sh paused: local is under memory pressure: 1.5 GiB available, under 2 GiB');
    expect(r.stderr).toContain('hopper-heavy: sh runs again: the memory pressure cleared');
    // At the second renew the group was stopped by the first one's answer; at the third, by the second's.
    expect(states.slice(1, 3)).toEqual(['T', 'T']);
    expect(states[3]).not.toBe('T');
  });
});
