// Issue #2622 part 3, through the real daemon, its HTTP server and the client a job runs: `POST /job/heavy` with the job's
// proxy token, and `sh "$HOPPER_HEAVY"` in front of a heavy step. On a 14 GiB machine with 10 GiB available, three JVM
// builds asked at once: two run, the third waits with the reason and runs once one ended. Only a job at work asks.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceReading } from '../../src/domain/types.ts';
import { run, running, start, stopGitProxies } from '../support/git-proxy.ts';

afterEach(stopGitProxies);

const GIB = 1024 ** 3;
const VM: ResourceReading = { cores: 8, cpuBusyFrac: 0.1, load: [1, 1, 1], memTotalBytes: 14 * GIB, memAvailableBytes: 10 * GIB };
// A stand-in JVM build: it logs when it starts and ends, and runs for a second.
const GRADLEW = '#!/bin/sh\necho "start $1 $(date +%s%N)" >> "$LOG"\nsleep 1\necho "end $1 $(date +%s%N)" >> "$LOG"\n';

async function atWork() {
  const t = await start({ localResources: () => VM });
  const r = await running(t);
  const heavy = join(t.root, r.env.HOPPER_HEAVY!);
  const token = readFileSync(join(t.root, r.env.HOPPER_TOKEN_FILE!), 'utf8').trim();
  const tokenFile = join(t.root, r.env.HOPPER_TOKEN_FILE!);
  const ask = (body: unknown, auth = `Bearer ${token}`) => fetch(new URL('/job/heavy', r.env.HOPPER_URL), {
    method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { t, r, heavy, tokenFile, ask };
}

describe('the heavy-step gate (issue #2622 part 3)', () => {
  it('three JVM builds asked at once on a 14 GiB machine: two run, the third waits with the reason, then runs', async () => {
    const { r, heavy, tokenFile } = await atWork();
    const gradlew = join(r.home, 'gradlew');
    writeFileSync(gradlew, GRADLEW, { mode: 0o755 });
    const log = join(r.home, 'log');
    writeFileSync(log, '');
    const env = { PATH: process.env.PATH, HOPPER_URL: r.env.HOPPER_URL, HOPPER_TOKEN_FILE: tokenFile, LOG: log };
    const builds = await Promise.all(['a', 'b', 'c'].map(async (id, i) => {
      await new Promise((ok) => setTimeout(ok, i * 50));
      return run('sh', [heavy, gradlew, id], { cwd: r.home, env });
    }));
    expect(builds.map((b) => b.code)).toEqual([0, 0, 0]);
    const waited = builds.find((b) => b.stderr.includes('waits'))!;
    expect(waited.stderr).toContain('hopper-heavy: gradlew waits: local runs 2 JVM builds, and holds at most 2 at once: 14 GiB less its floor of 1.4 GiB, at up to 5 GiB a build');
    expect(waited.stderr).toContain('hopper-heavy: gradlew runs: the memory holds it now');
    // At no time did three run at once.
    const events = readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')).map(([what, , at]) => ({ what, at: Number(BigInt(at!) / 1_000_000n) }))
      .sort((x, y) => x.at - y.at);
    let now = 0, most = 0;
    for (const e of events) { now += e.what === 'start' ? 1 : -1; most = Math.max(most, now); }
    expect(events).toHaveLength(6);
    expect(most).toBe(2);
  }, 30_000);

  it('a command that is no heavy step is told so; a slot is renewed and let go only by its own job', async () => {
    const { ask } = await atWork();
    expect(await (await ask({ op: 'take', argv: ['npm', 'run', 'lint'] })).json()).toEqual({ light: 'npm run lint is no heavy step' });
    const taken = await (await ask({ op: 'take', argv: ['npm', 'ci'] })).json() as { slot: string; renewS: number };
    expect(taken.renewS).toBe(20);
    expect(await (await ask({ op: 'renew', slot: taken.slot })).json()).toEqual({ ok: true });
    expect(await (await ask({ op: 'release', slot: taken.slot })).json()).toEqual({ ok: true });
    expect(await (await ask({ op: 'release', slot: taken.slot })).json()).toEqual({ ok: false });
  });

  it('a token that is no job\'s, or a bad call, is refused', async () => {
    const { ask } = await atWork();
    const stranger = await ask({ op: 'take', argv: ['npm', 'ci'] }, 'Bearer not-a-token');
    expect(stranger.status).toBe(401);
    expect(await stranger.text()).toContain('no: the token is not a job\'s of this hopper');
    const bad = await ask({ op: 'take', argv: [] });
    expect(bad.status).toBe(400);
  });
});
