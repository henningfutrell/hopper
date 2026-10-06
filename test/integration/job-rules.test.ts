// The job rules (issue #172): the config record `job-rules` as the UI reads it (GET /api/job-rules) and
// edits it (POST /ui/api/job-rules) — against its version, size-capped, behind an admin UI session — and
// read when each job starts, so a saved edit reaches the next job without a restart. Missing → the
// default job rules; the work tree and protocol lines are fixed and shown as such.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { JobRulesView } from '../../src/domain/types.ts';
import { DEFAULT_JOB_RULES, FIXED_JOB_LINES } from '../../src/job-rules/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeConfig } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** What each job the recorder ran was given as its job rules. */
const seen: (string | undefined)[] = [];
const recorder: Executor = {
  name: 'recorder', idempotent: false, validate: () => null,
  async run(ctx) { seen.push(ctx.jobRules); return { kind: 'finished', result: {} }; },
};

async function start(o: { jobRules?: string } = {}) {
  seen.length = 0;
  const db = tempDbPath();
  cleanup = db.cleanup;
  if (o.jobRules !== undefined) writeConfig(db.dbPath, 'job-rules', o.jobRules);
  t = await startTestApp({ dbPath: db.dbPath, seams: { executors: [recorder] } });
  return t;
}
const stored = (a: TestApp) => a.user().store.config.read('job-rules');
const sha = (text: string) => createHash('sha256').update(JSON.stringify(text)).digest('hex');
const view = async (a: TestApp) => (await a.api<JobRulesView>('GET', '/api/job-rules')).body;
const runJob = async (a: TestApp) => {
  const before = seen.length;
  await a.pull({}, { executor: 'recorder' });
  await waitFor(async () => seen.length > before, { what: 'the job to start' });
  return seen.at(-1);
};

describe('GET /api/job-rules', () => {
  it('missing: the default, version `missing`, with the default and the fixed lines', async () => {
    const a = await start();
    expect(await view(a)).toEqual({ text: DEFAULT_JOB_RULES, version: 'missing', missing: true, default: DEFAULT_JOB_RULES, fixed: [...FIXED_JOB_LINES] });
  });

  it('saved: the text and its version', async () => {
    const a = await start({ jobRules: 'Be brief.\n' });
    expect(await view(a)).toMatchObject({ text: 'Be brief.\n', version: sha('Be brief.\n'), missing: false });
  });
});

describe('POST /ui/api/job-rules', () => {
  it('saves the text against the version read; answers the new view', async () => {
    const a = await start();
    const token = await a.login();
    const res = await a.ui<JobRulesView>('/ui/api/job-rules', { text: 'Never touch main.\n', version: 'missing' }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ text: 'Never touch main.\n', version: sha('Never touch main.\n'), missing: false });
    expect(stored(a)).toBe('Never touch main.\n');
  });

  it('a stale version is 409 and nothing is written', async () => {
    const a = await start({ jobRules: 'v1' });
    const token = await a.login();
    writeConfig(a.dbPath, 'job-rules', 'edited elsewhere');
    const res = await a.ui<{ error: string }>('/ui/api/job-rules', { text: 'from the UI', version: sha('v1') }, { token });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/the job rules changed since they were read/);
    expect(stored(a)).toBe('edited elsewhere');
  });

  it('text over 16 KiB is 400 and nothing is written', async () => {
    const a = await start();
    const token = await a.login();
    const res = await a.ui<{ error: string }>('/ui/api/job-rules', { text: 'a'.repeat(16 * 1024 + 1), version: 'missing' }, { token });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/16 KiB/);
    expect(stored(a)).toBeUndefined();
  });

  it('without a UI session it is 403 and nothing is written', async () => {
    const a = await start();
    const res = await a.ui('/ui/api/job-rules', { text: 'sneaky', version: 'missing' });
    expect(res.status).toBe(403);
    expect(stored(a)).toBeUndefined();
  });
});

describe('a job starts with the job rules as they are then', () => {
  it('the default while none are saved; the saved text from the next job on, without a restart', async () => {
    const a = await start();
    expect(await runJob(a)).toBe(DEFAULT_JOB_RULES);
    const token = await a.login();
    expect((await a.ui('/ui/api/job-rules', { text: 'Always write in French.', version: 'missing' }, { token })).status).toBe(200);
    expect(await runJob(a)).toBe('Always write in French.');
  });
});
