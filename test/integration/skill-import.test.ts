// A library skill imported from a GitHub repository, and refreshed from it (issue #1911): read with the user's own GitHub
// connection — the account of the repository —, kept as a version of the user's skill library, and recorded. The daemon,
// store and HTTP edge are real; GitHub is the fake (test/support/fake-forges.ts), its files and heads set by the test; the
// job's machine is a fresh double with no workflow repository.
//
// Feature: import a skill from a repository
//   Scenario: an admin imports a skill's folder; a job on a fresh machine gets it
//   Scenario: refresh keeps a new version only when the folder changed, and records each refresh
//   Scenario: an import with no SKILL.md, of a name in use, or of a skill edited since is refused
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import type { SkillLibraryView } from '../../src/skill-library/index.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const REPO = 'octo/workflows';
/** Puts a file on the fake's default branch, and moves its head to a new commit. */
function put(github: FakeForge, path: string, content: string): void {
  const sha = createHash('sha1').update(content).digest('hex');
  github.files = { ...github.files, [`${REPO}@dev:${path}`]: { content, sha, message: 'test' } };
  github.heads = { ...github.heads, [`${REPO}@HEAD`]: createHash('sha1').update(JSON.stringify(github.files)).digest('hex') };
}

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-skill-import-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath, seams: { executors: [h.executor] }, plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools'], { token: github.mint('owner').accessToken });
  put(github, 'skills/workflow-orchestrate/SKILL.md', '---\nname: orchestrate\ndescription: Task lists and tiers.\n---\nv1');
  put(github, 'skills/workflow-orchestrate/scripts/orchestrate.sh', 'echo v1\n');
  put(github, 'skills/other/SKILL.md', 'other');
  put(github, 'README.md', 'not a skill');
  return { app, github, root, held: h.held, token: await app.login() };
}

type T = Awaited<ReturnType<typeof start>>;
const change = (t: T, body: unknown, token: string | null = t.token) => t.app.ui<SkillLibraryView & { error?: string }>('/ui/api/skill-library', body, token ? { token } : {});
const eventsOf = (t: T, type: string): DomainEvent[] => t.app.user().store.events.recent(1000).filter((e) => e.type === type);
const skillOf = (v: SkillLibraryView, name: string) => v.skills.find((s) => s.name === name);

describe('a skill imported from a repository (issue #1911)', () => {
  it('imports the folder\'s files with the account of the repository, records where they came from, and a job on a fresh machine gets them', async () => {
    const t = await start();
    const imported = await change(t, { action: 'import', repo: REPO, path: 'skills/workflow-orchestrate' });
    expect(imported.status, imported.body.error).toBe(200);
    const head = t.github.heads![`${REPO}@HEAD`]!;
    expect(skillOf(imported.body, 'workflow-orchestrate')).toMatchObject({
      builtIn: false, description: 'Task lists and tiers.', versions: 1,
      latest: { seq: 1, source: { kind: 'imported', repo: REPO, path: 'skills/workflow-orchestrate', ref: 'HEAD', commit: head } },
    });
    const one = (await t.app.api('GET', '/api/skill-library/workflow-orchestrate')).body;
    expect(one.skill.files).toEqual({ 'SKILL.md': '---\nname: orchestrate\ndescription: Task lists and tiers.\n---\nv1', 'scripts/orchestrate.sh': 'echo v1\n' });
    expect(eventsOf(t, 'library_skill.saved').map((e) => e.data)).toEqual([expect.objectContaining({ name: 'workflow-orchestrate', seq: 1, source: { kind: 'imported', repo: REPO, path: 'skills/workflow-orchestrate', ref: 'HEAD', commit: head } })]);
    // Read with the user's own connection.
    expect(t.github.requests.some((r) => r.path.includes('/git/trees/') && r.auth !== '')).toBe(true);

    // A name of its own, at a ref of its own.
    t.github.heads = { ...t.github.heads, [`${REPO}@dev`]: head };
    const named = await change(t, { action: 'import', repo: REPO, path: '/skills/other/', ref: 'dev', name: 'mine' });
    expect(named.status, named.body.error).toBe(200);
    expect(skillOf(named.body, 'mine')!.latest.source).toEqual({ kind: 'imported', repo: REPO, path: 'skills/other', ref: 'dev', commit: head });

    await t.app.ui('/ui/api/work-skills', { kinds: { code: 'workflow-orchestrate' } }, { token: t.token });
    const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/tools' });
    const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
    expect(readFileSync(join(t.root, env.HOPPER_WORK_SKILL!.replace('SKILL.md', 'scripts/orchestrate.sh')), 'utf8')).toBe('echo v1\n');
    t.held.get(job.id)!.end();
  });

  it('refresh reads the same folder at the same ref again: a new version only when it changed, and each refresh recorded', async () => {
    const t = await start();
    await change(t, { action: 'import', repo: REPO, path: 'skills/workflow-orchestrate' });
    const same = await change(t, { action: 'refresh', name: 'workflow-orchestrate' });
    expect(same.status, same.body.error).toBe(200);
    expect(skillOf(same.body, 'workflow-orchestrate')!.versions).toBe(1);

    put(t.github, 'skills/workflow-orchestrate/SKILL.md', 'v2');
    const changed = await change(t, { action: 'refresh', name: 'workflow-orchestrate' });
    expect(skillOf(changed.body, 'workflow-orchestrate')).toMatchObject({ versions: 2, latest: { seq: 2, source: { kind: 'imported', ref: 'HEAD', commit: t.github.heads![`${REPO}@HEAD`] } } });
    expect((await t.app.api('GET', '/api/skill-library/workflow-orchestrate')).body.skill.files['SKILL.md']).toBe('v2');
    expect(eventsOf(t, 'library_skill.refreshed').map((e) => [e.data.name, e.data.changed, e.data.version !== undefined])).toEqual([['workflow-orchestrate', true, true], ['workflow-orchestrate', false, true]]);
    expect(eventsOf(t, 'library_skill.saved').map((e) => e.data.seq)).toEqual([2, 1]);
  });

  it('refuses a folder with no SKILL.md, a name in use, a built-in or edited skill\'s refresh, and a change with no session', async () => {
    const t = await start();
    const none = await change(t, { action: 'import', repo: REPO, path: '' });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/no SKILL\.md/);
    expect((await change(t, { action: 'import', repo: REPO, path: 'skills/nope' })).status).toBe(404);
    expect((await change(t, { action: 'import', repo: REPO, path: 'skills/../x' })).status).toBe(400);
    expect((await change(t, { action: 'import', repo: REPO, path: 'skills/workflow-orchestrate', name: 'work' })).status).toBe(409);
    expect((await change(t, { action: 'refresh', name: 'work' })).status).toBe(409);
    expect((await change(t, { action: 'refresh', name: 'nope' })).status).toBe(404);
    await change(t, { action: 'import', repo: REPO, path: 'skills/workflow-orchestrate' });
    expect((await change(t, { action: 'import', repo: REPO, path: 'skills/workflow-orchestrate' })).status).toBe(409);
    // An edit is the person's: refresh would lose it.
    await change(t, { action: 'edit', name: 'workflow-orchestrate', files: { 'SKILL.md': 'mine' } });
    expect((await change(t, { action: 'refresh', name: 'workflow-orchestrate' })).body.error).toMatch(/edited since/);
    expect((await change(t, { action: 'import', repo: REPO, path: 'skills/other', name: 'sneaky' }, null)).status).toBe(403);
    expect(eventsOf(t, 'library_skill.refreshed')).toEqual([]);
  });
});
