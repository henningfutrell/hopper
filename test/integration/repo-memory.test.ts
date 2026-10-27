// Repository memory (issue #2847, design.md "Repository memory"): a finished job's memory lines become memory entries of
// its repository; once a person approves one, the next job of that repository — and of no other — is told it, and the
// job records which entries it got (`job.memory_offered`). A person's edit, removal or a later job's flag reaches the next
// job; the settings record `repo-memory` turns it off or the approval step off.
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { MemoryEntry, RepoMemoryView } from '../../src/domain/repo-memory.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

/** What each job the executor ran was told; it ends done with its payload's `message` as its final message. */
const seen: (string | undefined)[] = [];
const memo: Executor = {
  name: 'memo', idempotent: false, validate: () => null,
  async run(ctx) {
    seen.push(ctx.jobRules);
    const { message } = JSON.parse(String(ctx.job.spec.payload.prompt)) as { message?: string };
    return { kind: 'finished', result: { summary: message ?? '' } };
  },
};

async function start() {
  seen.length = 0;
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, seams: { executors: [memo] } });
  return t;
}

/** Run one job of `repo` that ends with `message`; what it was told of its repository's memory, and its id. */
async function runJob(a: TestApp, repo: string, message = 'Done.'): Promise<{ told: string; jobId: string }> {
  const before = seen.length;
  const job = await a.pull({ message }, { executor: 'memo', repo });
  await waitFor(async () => seen.length > before, { what: 'the job to start' });
  await a.waitForStatus(job.id, 'finished');
  const rules = seen.at(-1) ?? '';
  const at = rules.indexOf('[hopper repository memory]');
  return { told: at < 0 ? '' : rules.slice(at).replace(/\n\[hopper work skill\][\s\S]*$/, ''), jobId: job.id };
}

const view = async (a: TestApp, repo?: string) => (await a.api<RepoMemoryView>('GET', `/api/repo-memory${repo ? `?repo=${repo}` : ''}`)).body;
const act = async (a: TestApp, token: string, body: Record<string, unknown>) => a.ui<{ entry: MemoryEntry }>('/ui/api/repo-memory', body, { token });

describe('repository memory', () => {
  it('learned by one job, approved by a person, offered to the next job of the same repository and not of another', async () => {
    const a = await start();
    const first = await runJob(a, 'acme/app', 'Fixed it.\nHOPPER_MEMORY convention: Run `npm run check` before a push.\nHOPPER_DONE');
    expect(first.told).toMatch(/^\[hopper repository memory\] The hopper keeps no memory entry of acme\/app for jobs yet\./);
    const [learned] = (await view(a, 'acme/app')).entries;
    expect(learned).toMatchObject({ repo: 'acme/app', kind: 'convention', text: 'Run `npm run check` before a push.', state: 'proposed', confidence: 0.5, sourceJobId: first.jobId, expired: false });
    expect((await a.events('types=repo_memory.learned')).map((e) => e.data)).toContainEqual(expect.objectContaining({ entry: learned!.id, state: 'proposed', again: false }));

    // Proposed: not offered yet.
    expect((await runJob(a, 'acme/app')).told).toContain('keeps no memory entry');

    const token = await a.login();
    expect((await act(a, token, { action: 'approve', id: learned!.shortId })).status).toBe(200);
    const next = await runJob(a, 'acme/app');
    expect(next.told).toContain(`\n- ${learned!.shortId} (convention) Run \`npm run check\` before a push.\n`);
    const offered = (await a.events('types=job.memory_offered')).filter((e) => e.jobId === next.jobId).map((e) => e.data);
    expect(offered).toEqual([{ repo: 'acme/app', entries: [learned!.id], left: 0 }]);

    const other = await runJob(a, 'other/app');
    expect(other.told).not.toContain('npm run check');
    expect(other.told).toContain('keeps no memory entry of other/app');
  });

  it('a person\'s edit and removal reach the next job; a job\'s wrong line flags an entry until a person approves it again', async () => {
    const a = await start();
    const token = await a.login();
    const added = await act(a, token, { action: 'add', repo: 'acme/app', kind: 'fix', area: 'src/store/', text: 'Append migrations.' });
    expect(added.status).toBe(200);
    const e = added.body.entry;
    expect(e).toMatchObject({ area: 'src/store', state: 'approved', confidence: 1 });
    expect((await act(a, token, { action: 'add', repo: 'acme/app', kind: 'fix', area: 'src/store', text: 'append  migrations.' })).status).toBe(409);

    expect((await act(a, token, { action: 'edit', id: e.id, text: 'Append migrations to the recent list.' })).status).toBe(200);
    const sid = (await view(a)).entries[0]!.shortId;
    expect((await runJob(a, 'acme/app', `HOPPER_MEMORY_WRONG ${sid}: the list moved.`)).told).toContain(`- ${sid} (fix, src/store) Append migrations to the recent list.`);
    expect((await view(a)).entries[0]).toMatchObject({ state: 'flagged', flag: { reason: 'the list moved.' } });
    expect((await runJob(a, 'acme/app')).told).not.toContain('Append migrations');

    expect((await act(a, token, { action: 'approve', id: e.id })).status).toBe(200);
    expect((await runJob(a, 'acme/app')).told).toContain('Append migrations');
    expect((await act(a, token, { action: 'disable', id: e.id })).status).toBe(200);
    expect((await runJob(a, 'acme/app')).told).not.toContain('Append migrations');
    expect((await act(a, token, { action: 'enable', id: e.id })).status).toBe(200);
    expect((await act(a, token, { action: 'remove', id: e.id })).body).toEqual({ removed: true });
    expect((await runJob(a, 'acme/app')).told).not.toContain('Append migrations');
    expect((await act(a, token, { action: 'remove', id: e.id })).status).toBe(404);
    expect((await a.events('types=repo_memory.changed')).map((x) => x.data.change)).toEqual(['added', 'edited', 'approved', 'disabled', 'enabled', 'removed']);
  });

  it('a change needs an admin session; a bad entry is 400', async () => {
    const a = await start();
    expect((await a.ui('/ui/api/repo-memory', { action: 'add', repo: 'acme/app', kind: 'fix', text: 't' })).status).toBe(403);
    const token = await a.login();
    expect((await act(a, token, { action: 'add', repo: 'acme', kind: 'fix', text: 't' })).status).toBe(400);
    expect((await act(a, token, { action: 'add', repo: 'acme/app', kind: 'fix', text: 'a\nb' })).status).toBe(400);
  });

  it('the settings: with approval off a learned entry is offered at once; off for a repository, nothing is learned or told', async () => {
    const a = await start();
    const token = await a.login();
    const { version } = await view(a);
    expect(version).toBe('missing');
    expect((await a.ui('/ui/api/repo-memory/settings', { settings: { maxBytes: 1 }, version }, { token })).status).toBe(400);
    const saved = await a.ui<{ version: string }>('/ui/api/repo-memory/settings', { settings: { approval: false, repos: { 'acme/off': { on: false } } }, version }, { token });
    expect(saved.status).toBe(200);
    expect((await a.ui('/ui/api/repo-memory/settings', { settings: {}, version }, { token })).status).toBe(409);

    await runJob(a, 'acme/app', 'HOPPER_MEMORY fix: Use the shared helper.');
    expect((await runJob(a, 'acme/app')).told).toContain('(fix) Use the shared helper.');
    expect((await runJob(a, 'acme/off', 'HOPPER_MEMORY fix: Never kept.')).told).toBe('');
    expect((await view(a, 'acme/off')).entries).toEqual([]);

    // Learned again: one entry, more confident.
    await runJob(a, 'acme/app', 'HOPPER_MEMORY fix: use the shared  helper.');
    expect((await view(a, 'acme/app')).entries).toEqual([expect.objectContaining({ text: 'Use the shared helper.', confidence: 0.6 })]);
  });
});
