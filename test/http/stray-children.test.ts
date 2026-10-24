// Issue #2623: the hopper's process left zombie git, ssh and agent CLI processes for its whole life. Node waits on every
// child it starts, so they were orphans of its children, given to it as its container's PID 1. These tests read /proc:
// the counter finds a process's zombie and orphaned children; the git, ssh and agent paths leave no child behind when they
// finish, fail, time out or are cancelled; and 1,000 short git and 1,000 short ssh calls leave no zombie.
import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { run } from '../../src/executors/command.ts';
import { runGit } from '../../src/git-mirror/mirrors.ts';
import { stateRoutes } from '../../src/http/state.ts';
import { STRAY_CHILDREN_LIMIT, strayChildrenOf, watchStrayChildren } from '../../src/http/stray-children.ts';
import { claudePrint } from '../../src/plugins/claude-print.ts';

let dir: string;
let silent: Server;
let silentPort: number;
const peers = new Set<Socket>();
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jh-strays-'));
  // A peer that takes the connection and never says a word: ssh waits on its banner until it is stopped.
  silent = createServer((socket) => { peers.add(socket); socket.on('error', () => undefined); });
  await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
  silentPort = (silent.address() as { port: number }).port;
});
afterAll(async () => {
  for (const socket of peers) socket.destroy();
  await new Promise((resolve) => silent.close(resolve));
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** This process's children once Node waited on the ones that ended: none is left of a call that settled. */
async function childrenLeft(): Promise<{ zombies: number; orphans: number }> {
  let r = strayChildrenOf(process.pid, new Set());
  for (let i = 0; i < 40 && r.zombies + r.orphans > 0; i++) { await sleep(50); r = strayChildrenOf(process.pid, new Set()); }
  return { zombies: r.zombies, orphans: r.orphans };
}
const NONE = { zombies: 0, orphans: 0 };

/** A program the test runs as another process's parent; `stop` ends it and its children, and waits until Node waited on it. */
function parentOf(script: string): { pid: number; stop: () => Promise<void> } {
  const child = spawn('sh', ['-c', script], { detached: true, stdio: 'ignore' });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const pid = child.pid!;
  const stop = async () => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } await exited; };
  return { pid, stop };
}

describe('the stray children counter', () => {
  it('counts a zombie child of a process that never waits on it', async () => {
    // sh starts `true` and then becomes sleep, which never waits on it: `true` stays a zombie of that pid.
    const p = parentOf('/bin/true & exec sleep 30');
    try {
      let r = strayChildrenOf(p.pid, new Set());
      for (let i = 0; i < 40 && r.zombies === 0; i++) { await sleep(50); r = strayChildrenOf(p.pid, new Set()); }
      expect(r).toEqual({ zombies: 1, orphans: 0, programs: ['true'] });
    } finally { await p.stop(); }
  });

  it('counts a live child the process did not start as an orphan, and not one it started', async () => {
    const p = parentOf('sleep 30 & exec sleep 31');
    try {
      // The background child is a fork of sh until it runs sleep: wait until /proc names it sleep.
      let r = strayChildrenOf(p.pid, new Set());
      for (let i = 0; i < 40 && r.programs[0] !== 'sleep'; i++) { await sleep(50); r = strayChildrenOf(p.pid, new Set()); }
      expect(r).toEqual({ zombies: 0, orphans: 1, programs: ['sleep'] });
    } finally { await p.stop(); }
  });

  it('reads a program name with spaces and parentheses, and skips what is gone', () => {
    const proc = join(dir, 'proc');
    const stat = (pid: number, comm: string, state: string, ppid: number) => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${comm}) ${state} ${ppid} 1 1 0 -1\n`);
    };
    stat(10, 'claude.exe', 'Z', 7);
    stat(11, 'a) (b', 'Z', 7);
    stat(12, 'ssh', 'S', 7);
    stat(13, 'git', 'Z', 8);
    stat(14, 'git', 'S', 7);
    mkdirSync(join(proc, '15'));
    mkdirSync(join(proc, 'self'), { recursive: true });
    expect(strayChildrenOf(7, new Set([14]), proc)).toEqual({ zombies: 2, orphans: 1, programs: ['claude.exe', 'a) (b', 'ssh'] });
  });

  it('is a problem only above the limit, logged once each time it goes over', () => {
    const proc = join(dir, 'proc-limit');
    const lines: string[] = [];
    const w = watchStrayChildren({ pid: 7, procRoot: proc, log: (l) => lines.push(l) });
    const zombies = (n: number) => {
      rmSync(proc, { recursive: true, force: true });
      for (let i = 0; i < n; i++) {
        mkdirSync(join(proc, String(100 + i)), { recursive: true });
        writeFileSync(join(proc, String(100 + i), 'stat'), `${100 + i} (git) Z 7 1 1\n`);
      }
    };
    zombies(STRAY_CHILDREN_LIMIT);
    expect(w.problem(0)).toBeUndefined();
    zombies(STRAY_CHILDREN_LIMIT + 1);
    // Read at most every 30 s: the count of the read before stands.
    expect(w.problem(1000)).toBeUndefined();
    expect(w.problem(30_000)).toEqual({ zombies: STRAY_CHILDREN_LIMIT + 1, orphans: 0, programs: ['git'] });
    expect(w.problem(60_000)).toBeDefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('6 zombie and 0 orphaned child processes (git)');
    zombies(0);
    expect(w.problem(90_000)).toBeUndefined();
    zombies(STRAY_CHILDREN_LIMIT + 1);
    expect(w.problem(120_000)).toBeDefined();
    expect(lines).toHaveLength(2);
  });

  it('knows the children this process started while they run, and drops them when they end', async () => {
    const w = watchStrayChildren();
    const child = spawn('sleep', ['30']);
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      expect(w.started().has(child.pid!)).toBe(true);
      expect(strayChildrenOf(process.pid, w.started())).toEqual({ zombies: 0, orphans: 0, programs: [] });
    } finally { child.kill('SIGKILL'); }
    await exited;
    expect(w.started().has(child.pid!)).toBe(false);
  });
});

describe('/api/health', () => {
  const healthOf = async (strays: () => ReturnType<typeof strayChildrenOf> | undefined) => {
    const app = Fastify();
    stateRoutes(app, { tenant: () => { throw new Error('no user in this test'); }, clock: { now: () => new Date() }, version: '1.0.0', port: () => 0, sandboxes: { view: () => { throw new Error('unused'); } }, strays });
    const body = (await app.inject({ method: 'GET', url: '/api/health' })).json() as Record<string, unknown>;
    await app.close();
    return body;
  };

  it('shows the stray children while they are a problem, and nothing else of them', async () => {
    const strays = { zombies: 12, orphans: 2, programs: ['git', 'ssh', 'claude.exe'] };
    expect(await healthOf(() => strays)).toEqual({ ok: true, version: '1.0.0', uptimeS: expect.any(Number), strayChildren: strays });
    expect(await healthOf(() => undefined)).toEqual({ ok: true, version: '1.0.0', uptimeS: expect.any(Number) });
  });
});

describe('the git, ssh and agent paths leave no child', () => {
  const never = new AbortController().signal;

  it('git: a finished call, a failed call, a timeout and a cancel', async () => {
    expect((await runGit(['--version'], {})).code).toBe(0);
    expect(await childrenLeft()).toEqual(NONE);
    expect((await runGit(['--git-dir', join(dir, 'none'), 'log'], {})).code).not.toBe(0);
    expect(await childrenLeft()).toEqual(NONE);
    // git cat-file --batch reads its stdin, which the call never closes: it runs until it is stopped.
    const repo = join(dir, 'repo');
    expect((await runGit(['init', '-q', '--bare', repo], {})).code).toBe(0);
    expect(await run('git', ['--git-dir', repo, 'cat-file', '--batch'], 300, never)).toBe('timeout');
    expect(await childrenLeft()).toEqual(NONE);
    const ac = new AbortController();
    const cancelled = run('git', ['--git-dir', repo, 'cat-file', '--batch'], 20_000, ac.signal);
    await sleep(200);
    ac.abort();
    expect(await cancelled).toBe('aborted');
    expect(await childrenLeft()).toEqual(NONE);
  });

  it('ssh: a finished call, a failed connection, a timeout and a cancel', async () => {
    const ssh = ['-F', '/dev/null', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', `UserKnownHostsFile=${join(dir, 'known_hosts')}`, '-o', 'ConnectTimeout=20'];
    expect(await run('ssh', ['-V'], 20_000, never)).toMatchObject({ exitCode: 0 });
    expect(await childrenLeft()).toEqual(NONE);
    // A closed port: refused at once.
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const closedPort = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));
    expect(await run('ssh', [...ssh, '-p', String(closedPort), '127.0.0.1', 'true'], 20_000, never)).toMatchObject({ exitCode: 255 });
    expect(await childrenLeft()).toEqual(NONE);
    // A peer that never answers: ssh waits until the call is stopped.
    expect(await run('ssh', [...ssh, '-p', String(silentPort), '127.0.0.1', 'true'], 300, never)).toBe('timeout');
    expect(await childrenLeft()).toEqual(NONE);
    const ac = new AbortController();
    const cancelled = run('ssh', [...ssh, '-p', String(silentPort), '127.0.0.1', 'true'], 20_000, ac.signal);
    await sleep(200);
    ac.abort();
    expect(await cancelled).toBe('aborted');
    expect(await childrenLeft()).toEqual(NONE);
  });

  it('the agent CLI: a finished run, a failed run, a timeout and a cancel', async () => {
    const bin = join(dir, 'claude');
    // A stand-in for the agent CLI: it says one result, fails, or waits, as its model says.
    writeFileSync(bin, '#!/bin/sh\ncat >/dev/null\ncase "$*" in\n  *fails*) echo no >&2; exit 3 ;;\n  *waits*) exec sleep 30 ;;\n  *) echo \'{"type":"result","structured_output":{"ok":true}}\' ;;\nesac\n');
    chmodSync(bin, 0o755);
    const schema = z.object({ ok: z.boolean() });
    const opts = (model: string, timeoutMs = 20_000) => ({ bin, model, cwd: dir, timeoutMs, jsonSchema: {} });
    expect(await claudePrint(opts('runs'), schema, 'p', never)).toMatchObject({ ok: true });
    expect(await childrenLeft()).toEqual(NONE);
    expect(await claudePrint(opts('fails'), schema, 'p', never)).toMatchObject({ error: expect.stringContaining('exited 3') });
    expect(await childrenLeft()).toEqual(NONE);
    expect(await claudePrint(opts('waits', 300), schema, 'p', never)).toEqual({ error: 'timeout after 300ms' });
    expect(await childrenLeft()).toEqual(NONE);
    const ac = new AbortController();
    const cancelled = claudePrint(opts('waits'), schema, 'p', ac.signal);
    await sleep(200);
    ac.abort();
    expect(await cancelled).toEqual({ error: 'aborted' });
    expect(await childrenLeft()).toEqual(NONE);
  });
});

describe('a soak of short calls', () => {
  it('1,000 git and 1,000 ssh calls leave no zombie, at any point', async () => {
    const w = watchStrayChildren();
    const calls = [
      ...Array.from({ length: 1000 }, () => async () => expect((await runGit(['--version'], {})).code).toBe(0)),
      ...Array.from({ length: 1000 }, () => async () => expect(await run('ssh', ['-V'], 20_000, new AbortController().signal)).toMatchObject({ exitCode: 0 })),
    ];
    const AT_ONCE = 16;
    for (let i = 0; i < calls.length; i += AT_ONCE) {
      await Promise.all(calls.slice(i, i + AT_ONCE).map((call) => call()));
      // The calls of this batch settled: Node waited on each; nothing of them is a zombie.
      expect(strayChildrenOf(process.pid, w.started()).zombies).toBe(0);
    }
    expect(await childrenLeft()).toEqual(NONE);
  }, 180_000);
});
