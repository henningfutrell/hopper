// The job rules (issue #172): the config record `job-rules` as the UI reads it (GET /api/job-rules) and
// edits it (POST /ui/api/job-rules) — against its version, size-capped, behind an admin UI session — and
// read when each job starts, so a saved edit reaches the next job without a restart. Missing → the
// default job rules; the work tree and protocol lines are fixed and shown as such.
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { JobRulesView, RepoJobRulesView } from '../../src/domain/types.ts';
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
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const view = async (a: TestApp) => (await a.api<JobRulesView>('GET', '/api/job-rules')).body;
const runJob = async (a: TestApp, repo?: string) => {
  const before = seen.length;
  await a.pull({}, { executor: 'recorder', ...(repo ? { repo } : {}) });
  await waitFor(async () => seen.length > before, { what: 'the job to start' });
  // Its work skill's line comes last (issue #1911, test/integration/skill-library.test.ts).
  expect(seen.at(-1)).toMatch(/\[hopper work skill\] This job's skill for its kind of work \(code\) is work, version [0-9a-f]{16}\.[^\n]*$/);
  return seen.at(-1)?.replace(/\n?\[hopper work skill\][^\n]*$/, '');
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

// Issue #1472 part 4: rules per repository (`owner/name`) or per owner (`owner/*`), told after the job rules.
describe('the repository job rules', () => {
  const repoView = async (a: TestApp) => (await a.api<RepoJobRulesView>('GET', '/api/repo-job-rules')).body;

  it('GET: none yet, version `missing`; saved: each repository\'s, sorted', async () => {
    const a = await start();
    expect(await repoView(a)).toEqual({ repos: [], version: 'missing' });
    writeConfig(a.dbPath, 'repo-job-rules', { 'b/x': '2', 'a/*': '1' });
    expect(await repoView(a)).toEqual({ repos: [{ repo: 'a/*', text: '1' }, { repo: 'b/x', text: '2' }], version: sha({ 'b/x': '2', 'a/*': '1' }) });
  });

  it('POST saves them against the version read; stale is 409, invalid 400, without a session 403', async () => {
    const a = await start();
    expect((await a.ui('/ui/api/repo-job-rules', { repos: { 'acme/app': 'x' }, version: 'missing' })).status).toBe(403);
    const token = await a.login();
    expect((await a.ui('/ui/api/repo-job-rules', { repos: { acme: 'x' }, version: 'missing' }, { token })).status).toBe(400);
    const res = await a.ui<RepoJobRulesView>('/ui/api/repo-job-rules', { repos: { 'acme/app': 'x' }, version: 'missing' }, { token });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ repos: [{ repo: 'acme/app', text: 'x' }], version: sha({ 'acme/app': 'x' }) });
    expect((await a.ui('/ui/api/repo-job-rules', { repos: {}, version: 'missing' }, { token })).status).toBe(409);
    expect(a.user().store.config.read('repo-job-rules')).toEqual({ 'acme/app': 'x' });
  });

  it('a job of the repository gets them after the job rules; a job of another repository does not', async () => {
    const a = await start({ jobRules: 'Be brief.' });
    const token = await a.login();
    expect((await a.ui('/ui/api/repo-job-rules', { repos: { 'acme/*': 'Production stays with a person.', 'acme/app': 'Follow it to qa.' }, version: 'missing' }, { token })).status).toBe(200);
    expect((await runJob(a, 'acme/app'))?.replace(/\n\[hopper repository memory\][\s\S]*$/, '')).toBe([
      'Be brief.',
      '[hopper repository rules] Rules set in the hopper for every job of acme/*:', 'Production stays with a person.',
      '[hopper repository rules] Rules set in the hopper for every job of acme/app:', 'Follow it to qa.',
    ].join('\n'));
    // Then its repository's memory (issue #2847, test/integration/repo-memory.test.ts).
    expect(await runJob(a, 'other/app')).toMatch(/^Be brief\.\n\[hopper repository memory\] The hopper keeps no memory entry of other\/app for jobs yet\.\n/);
  });
});
