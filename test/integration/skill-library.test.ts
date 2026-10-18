// The skill library (issue #1911): the built-in library skills and the user's own as versions in their database, the
// choice of each kind of work's skill, and the job that gets it. The daemon, store and HTTP edge are real; the job's
// machine is a fresh double at the MachineShell port (test/support/job-holder.ts) with no workflow repository: its
// credential files are real files under a root.
//
// Feature: the skill library
//   Scenario: the library lists the built-in skills; an admin creates, edits, duplicates and removes their own
//   Scenario: an admin chooses a skill per kind of work, for every repository and per repository
//   Scenario: a job gets its work skill's files on its machine and its line in the job rules; the next job gets a change
//   Scenario: each action is a permission of its own, an admin's; with no session nothing changes
//   Scenario: a skill that requires others gets them beside it, each version kept for the job; one not in the library is said
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { workSkillOf, type SkillLibraryView } from '../../src/skill-library/index.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
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

async function start() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-skill-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const rules = new Map<string, string | undefined>();
  const executor: Executor = { ...h.executor, run: async (ctx) => { rules.set(ctx.job.id, ctx.jobRules); return h.executor.run(ctx); } };
  const app = await startTestApp({
    dbPath: db.dbPath, seams: { executors: [executor] }, plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools', 'octo/site']);
  return { app, root, held: h.held, rules, token: await app.login() };
}

type T = Awaited<ReturnType<typeof start>>;
const library = async (t: T) => (await t.app.api<SkillLibraryView>('GET', '/api/skill-library')).body;
const change = (t: T, body: unknown, token: string | null = t.token) => t.app.ui<SkillLibraryView & { error?: string }>('/ui/api/skill-library', body, token ? { token } : {});
const choose = (t: T, body: unknown) => t.app.ui<SkillLibraryView & { error?: string }>('/ui/api/work-skills', body, { token: t.token });
const eventsOf = (t: T, type: string): DomainEvent[] => t.app.user().store.events.recent(1000).filter((e) => e.type === type);

/** A job of `repo` that ran on the fresh machine: its variables, its job rules and its work skill's SKILL.md there. Ended, so its lane frees. */
async function running(t: T, repo: string, labels: string[] = []) {
  const job = await t.app.pull({}, { executor: 'holder', repo, labels });
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  t.held.get(job.id)!.end();
  await t.app.waitForStatus(job.id, 'finished');
  return { job, env, rules: t.rules.get(job.id) ?? '', skill: env.HOPPER_WORK_SKILL ? readFileSync(join(t.root, env.HOPPER_WORK_SKILL), 'utf8') : undefined };
}

describe('the skill library (issue #1911)', () => {
  it('lists the built-in skills; creates, edits (a new version), duplicates and removes the user\'s own, each an event', async () => {
    const t = await start();
    const first = await library(t);
    expect(first.skills.map((s) => [s.name, s.builtIn, s.latest.seq, s.requires])).toEqual([
      ['work', true, 0, ['orchestrate']], ['research', true, 0, []], ['proposal', true, 0, []], ['orchestrate', true, 0, []], ['iac', true, 0, []], ['gitops-deploy', true, 0, []],
    ]);
    expect(first.workSkills).toEqual({ kinds: {}, repos: {} });
    expect(first.defaults).toEqual({ code: 'work', research: 'research', proposal: 'proposal' });

    const created = await change(t, { action: 'create', name: 'careful', files: { 'SKILL.md': '---\nname: careful\ndescription: Go slowly.\n---\nv1', 'scripts/check.sh': 'echo ok\n' } });
    expect(created.status, created.body.error).toBe(200);
    expect(created.body.skills.find((s) => s.name === 'careful')).toMatchObject({ builtIn: false, description: 'Go slowly.', versions: 1, latest: { seq: 1, source: { kind: 'created' }, by: expect.any(String) } });
    expect((await change(t, { action: 'create', name: 'careful', files: { 'SKILL.md': 'x' } })).status).toBe(409);
    expect((await change(t, { action: 'edit', name: 'careful', files: { 'SKILL.md': 'v2' } })).body.skills.find((s) => s.name === 'careful')!.versions).toBe(2);
    // The same files again keep no version.
    expect((await change(t, { action: 'edit', name: 'careful', files: { 'SKILL.md': 'v2' } })).body.skills.find((s) => s.name === 'careful')!.versions).toBe(2);
    const one = (await t.app.api('GET', '/api/skill-library/careful')).body;
    expect(one.skill.files).toEqual({ 'SKILL.md': 'v2' });
    expect(one.versions.map((v: { seq: number }) => v.seq)).toEqual([2, 1]);
    const v1 = one.versions[1].version as string;
    expect((await t.app.api('GET', `/api/skill-library/careful?version=${v1}`)).body.skill.files['scripts/check.sh']).toBe('echo ok\n');

    // A built-in skill is never edited or removed; a copy of it is the user's to change.
    expect((await change(t, { action: 'edit', name: 'work', files: { 'SKILL.md': 'mine' } })).status).toBe(409);
    expect((await change(t, { action: 'remove', name: 'research' })).status).toBe(409);
    const dup = await change(t, { action: 'duplicate', from: 'work', name: 'my-work' });
    expect(dup.status, dup.body.error).toBe(200);
    expect(dup.body.skills.find((s) => s.name === 'my-work')!.latest.source).toEqual({ kind: 'duplicated', name: 'work', version: first.skills[0]!.latest.version });
    expect((await change(t, { action: 'duplicate', from: 'nope', name: 'x' })).status).toBe(404);
    expect((await change(t, { action: 'create', name: 'Bad Name', files: { 'SKILL.md': 'x' } })).status).toBe(400);
    expect((await change(t, { action: 'create', name: 'no-skill-md', files: { 'README.md': 'x' } })).status).toBe(400);
    expect((await change(t, { action: 'create', name: 'escapes', files: { 'SKILL.md': 'x', '../x': 'y' } })).status).toBe(400);

    expect((await change(t, { action: 'remove', name: 'my-work' })).body.skills.map((s) => s.name)).not.toContain('my-work');
    expect((await t.app.api('GET', '/api/skill-library/my-work')).status).toBe(404);
    expect(eventsOf(t, 'library_skill.saved').map((e) => [e.data.name, e.data.seq])).toEqual([['my-work', 1], ['careful', 2], ['careful', 1]]);
    expect(eventsOf(t, 'library_skill.removed').map((e) => e.data.name)).toEqual(['my-work']);
  });

  it('chooses a skill per kind of work; a skill not in the library is refused, and one a setting names is not removed', async () => {
    const t = await start();
    await change(t, { action: 'create', name: 'careful', files: { 'SKILL.md': 'careful' } });
    expect((await choose(t, { kinds: { code: 'nope' } })).status).toBe(404);
    const chosen = await choose(t, { kinds: { code: 'careful' }, repos: { 'Octo/Site': { code: 'work', research: 'careful' } } });
    expect(chosen.status, chosen.body.error).toBe(200);
    expect(chosen.body.workSkills).toEqual({ kinds: { code: 'careful' }, repos: { 'octo/site': { code: 'work', research: 'careful' } } });
    expect((await change(t, { action: 'remove', name: 'careful' })).body.error).toMatch(/a work skill setting names careful/);
    expect((await choose(t, { repos: { 'octo/site': { code: null, research: null } } })).body.workSkills).toEqual({ kinds: { code: 'careful' }, repos: {} });
    const [last] = eventsOf(t, 'work_skills.changed');
    expect(last!.data).toMatchObject({ from: { kinds: { code: 'careful' }, repos: { 'octo/site': { code: 'work', research: 'careful' } } }, to: { kinds: { code: 'careful' }, repos: {} } });
  });

  it('a job on a fresh machine gets its work skill: the files beside its scripts, its line in the job rules, the version on its timeline', async () => {
    const t = await start();
    const builtIn = await running(t, 'octo/tools');
    expect(builtIn.env.HOPPER_WORK_SKILL).toBe(`/work/.worktrees/@scratch/${builtIn.job.id}/credentials/work-skill/work/SKILL.md`);
    expect(builtIn.skill).toMatch(/^---\nname: work\n/);
    const work = (await library(t)).skills.find((s) => s.name === 'work')!.latest.version;
    expect(builtIn.rules).toContain(`[hopper work skill] This job's skill for its kind of work (code) is work, version ${work}.`);
    const orchestrate = (await library(t)).skills.find((s) => s.name === 'orchestrate')!.latest.version;
    expect(eventsOf(t, 'job.work_skill_chosen').map((e) => [e.jobId, e.data])).toEqual([[builtIn.job.id, {
      kind: 'code', name: 'work', version: work, seq: 0, from: 'default', requires: [{ name: 'orchestrate', version: orchestrate, seq: 0 }], missing: [],
    }]]);
    // The built-in work skill requires the built-in orchestrate skill: it comes beside it, with no workflow repository.
    expect(readFileSync(join(t.root, builtIn.env.HOPPER_WORK_SKILL!.replace('/work/SKILL.md', '/orchestrate/SKILL.md')), 'utf8')).toMatch(/^---\nname: orchestrate\n/);
    expect(builtIn.rules).toContain(`It requires orchestrate (version ${orchestrate})`);

    await change(t, { action: 'create', name: 'careful', files: { 'SKILL.md': 'Go slowly.', 'scripts/check.sh': 'echo ok\n' } });
    await choose(t, { kinds: { code: 'careful' }, repos: { 'octo/site': { research: 'careful' } } });
    const user = await running(t, 'octo/tools');
    expect(user.skill).toBe('Go slowly.');
    expect(readFileSync(join(t.root, user.env.HOPPER_WORK_SKILL!.replace('SKILL.md', 'scripts/check.sh')), 'utf8')).toBe('echo ok\n');
    expect(eventsOf(t, 'job.work_skill_chosen')[0]!.data).toMatchObject({ kind: 'code', name: 'careful', seq: 1, from: 'user' });

    // Research on octo/site: the repository's own setting wins.
    const research = await running(t, 'octo/site', ['hopper:research']);
    expect(research.rules).toContain('for its kind of work (research) is careful');
    expect(eventsOf(t, 'job.work_skill_chosen')[0]!.data).toMatchObject({ kind: 'research', name: 'careful', from: 'repo' });
    // A proposal there has no setting of the repository's or the user's: the built-in default.
    expect((await running(t, 'octo/site', ['hopper:proposal'])).skill).toMatch(/^---\nname: proposal\n/);

    // An edit reaches the next job; the job that got the old version keeps it.
    await change(t, { action: 'edit', name: 'careful', files: { 'SKILL.md': 'Go slower.' } });
    expect((await running(t, 'octo/tools')).skill).toBe('Go slower.');
    expect(readFileSync(join(t.root, user.env.HOPPER_WORK_SKILL!), 'utf8')).toBe('Go slowly.');
  });

  it('each action is a permission of its own, an admin\'s; with no session nothing changes', async () => {
    const t = await start();
    const registry = (await t.app.api('GET', '/api/scopes', undefined, { 'x-hopper-session': t.token })).body;
    const section = registry.sections.find((s: { id: string }) => s.id === 'skills');
    const scopes = Object.fromEntries((section.permissions as { scope: string; role: string }[]).map((p) => [p.scope, p.role]));
    expect(scopes).toEqual({
      'skill-library:read': 'viewer', 'skill-library:edit': 'admin', 'skill-library:edit.create': 'admin', 'skill-library:edit.duplicate': 'admin',
      'skill-library:edit.edit': 'admin', 'skill-library:edit.import': 'admin', 'skill-library:edit.refresh': 'admin', 'skill-library:edit.remove': 'admin',
      'work-skills:edit': 'admin',
    });
    expect((await change(t, { action: 'create', name: 'sneaky', files: { 'SKILL.md': 'x' } }, null)).status).toBe(403);
    expect((await t.app.ui('/ui/api/work-skills', { kinds: { code: 'research' } })).status).toBe(403);
    expect((await library(t)).skills.map((s) => s.name)).toEqual(['work', 'research', 'proposal', 'orchestrate', 'iac', 'gitops-deploy']);
    expect(eventsOf(t, 'library_skill.saved')).toEqual([]);
  });
});

describe('a job keeps the work skill it got (issue #1911)', () => {
  it('each later start gets the version of its first, after an edit and a new setting; a new kind of work chooses again', async () => {
    const t = await start();
    const { store } = t.app.user();
    await change(t, { action: 'create', name: 'careful', files: { 'SKILL.md': 'v1' } });
    await choose(t, { kinds: { code: 'careful' } });
    const job = { id: 'j-pinned', spec: {}, source: { repo: 'octo/tools' } } as Parameters<typeof workSkillOf>[1];
    const first = workSkillOf(store, job);
    expect(first.files).toEqual({ 'SKILL.md': 'v1' });
    await change(t, { action: 'edit', name: 'careful', files: { 'SKILL.md': 'v2' } });
    await choose(t, { kinds: { code: 'work' } });
    expect(workSkillOf(store, job)).toEqual(first);
    expect(workSkillOf(store, { ...job, id: 'j-next' }).chosen.name).toBe('work');
    expect(workSkillOf(store, { ...job, spec: { ...job.spec, research: true as const } }).chosen).toMatchObject({ kind: 'research', name: 'research', from: 'default' });
    expect(eventsOf(t, 'job.work_skill_chosen').filter((e) => e.jobId === 'j-pinned')).toHaveLength(2);
  });
});

describe('a skill that requires others (issue #1911)', () => {
  it('a job gets each skill it requires, and theirs, beside it; each version is kept for the job; one not in the library is said', async () => {
    const t = await start();
    const { store } = t.app.user();
    await change(t, { action: 'create', name: 'helper', files: { 'SKILL.md': '---\nname: helper\nrequires: orchestrate\n---\nhelper v1' } });
    const made = await change(t, { action: 'create', name: 'careful', files: { 'SKILL.md': '---\nname: careful\nrequires: [helper, careful, not-there]\n---\nGo slowly.' } });
    expect(made.status, made.body.error).toBe(200);
    expect(made.body.skills.find((s) => s.name === 'careful')!.requires).toEqual(['helper', 'careful', 'not-there']);
    expect((await change(t, { action: 'create', name: 'bad', files: { 'SKILL.md': '---\nrequires: Not A Name\n---\n' } })).status).toBe(400);
    await choose(t, { kinds: { code: 'careful' } });

    const job = await running(t, 'octo/tools');
    const dir = job.env.HOPPER_WORK_SKILL!.replace('/careful/SKILL.md', '');
    expect(readFileSync(join(t.root, dir, 'helper/SKILL.md'), 'utf8')).toMatch(/helper v1$/);
    expect(readFileSync(join(t.root, dir, 'orchestrate/SKILL.md'), 'utf8')).toMatch(/^---\nname: orchestrate\n/);
    const [chosen] = eventsOf(t, 'job.work_skill_chosen');
    expect(chosen!.data).toMatchObject({ name: 'careful', requires: [{ name: 'helper', seq: 1 }, { name: 'orchestrate', seq: 0 }], missing: ['not-there'] });
    expect(job.rules).toContain('It requires helper (version');
    expect(job.rules).toContain('The library has no skill not-there that it requires: go on without it.');

    // An edit of a skill it requires reaches the next job; a later start of this one keeps the version it got.
    const pinned = { id: 'j-pinned', spec: {}, source: { repo: 'octo/tools' } } as Parameters<typeof workSkillOf>[1];
    const first = workSkillOf(store, pinned);
    await change(t, { action: 'edit', name: 'helper', files: { 'SKILL.md': '---\nname: helper\n---\nhelper v2' } });
    expect(workSkillOf(store, pinned)).toEqual(first);
    expect(first.skills.find((s) => s.name === 'helper')!.files['SKILL.md']).toMatch(/helper v1$/);
    const next = workSkillOf(store, { ...pinned, id: 'j-next' });
    expect(next.skills.map((s) => s.name)).toEqual(['careful', 'helper']);
    expect(next.skills[1]!.files['SKILL.md']).toMatch(/helper v2$/);
  });
});
