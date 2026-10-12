// Issue #901: direct jobs from the operator CLI. `hopper job submit` makes the same POST /ui/api/direct-jobs call the UI
// makes, under a session minted for that one call; `hopper job direct [<id>]` reads the direct jobs back with their jobs.
// Real daemon, real CLI.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { DirectJobView } from '../../src/domain/direct-jobs.ts';
import { databaseUrlFor } from '../support/database.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) } });
  cleanups.push(() => a.stop());
  return a;
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('direct jobs from the CLI (issue #901)', () => {
  it('submits a direct job from a brief file, and reads it back with its result', async () => {
    const a = await boot();
    const dir = mkdtempSync(join(tmpdir(), 'hopper-brief-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'brief.md');
    writeFileSync(file, `${JSON.stringify({ op: 'echo', message: 'looked up' })}\nLook up the lockout.`);
    const r = await hopper(a, ['job', 'submit', '--title', 'Lockout lookup', '--brief-file', file, '--label', 'sme:identity', '--authorize', 'keycloak:read', '--executor', 'scripted', '--priority', '70']);
    expect(r).toMatchObject({ code: 0 });
    const { directJob, job } = JSON.parse(r.out) as { directJob: DirectJobView; job: { id: string; priority: number } };
    expect(directJob).toMatchObject({ title: 'Lockout lookup', labels: ['sme:identity'], authorizations: ['keycloak:read'], priority: 70, submittedBy: { via: 'cli' } });
    expect(job.priority).toBe(70);
    await a.waitForStatus(job.id, 'finished');

    const one = await waitFor(async () => {
      const d = JSON.parse((await hopper(a, ['job', 'direct', directJob.id])).out) as DirectJobView;
      return d.job?.status === 'finished' ? d : undefined;
    }, { what: 'the direct job read back' });
    expect(one.job?.result).toEqual({ echo: 'looked up' });
    expect((JSON.parse((await hopper(a, ['job', 'direct'])).out) as { directJobs: DirectJobView[] }).directJobs.map((d) => d.id)).toEqual([directJob.id]);
  });

  it('refuses a submit with no brief, with two briefs, or a priority out of range', async () => {
    const a = await boot();
    expect((await hopper(a, ['job', 'submit', '--title', 't'])).code).toBe(2);
    expect((await hopper(a, ['job', 'submit', '--title', 't', '--brief', 'b', '--brief-file', 'f'])).code).toBe(2);
    const far = await hopper(a, ['job', 'submit', '--title', 't', '--brief', 'b', '--priority', '101']);
    expect(far.code).toBe(2);
    expect(far.err).toContain('--priority');
  });
});
