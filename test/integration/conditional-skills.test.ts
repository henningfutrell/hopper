// Conditional skills (issue #1924): skill rules give a job library skills beside its work skill, by what it works on — its
// repository, its labels, its kind of work. The daemon, store and HTTP edge are real; the job's machine is a fresh double at
// the MachineShell port (test/support/job-holder.ts): its credential files are real files under a root.
//
// Feature: conditional skills
//   Scenario: an admin sets the skill rules; a rule that names no skill in the library, or no condition, is refused
//   Scenario: a job a rule matches gets the skill's files, an index, a line in its job rules, and why on its timeline
//   Scenario: a job no rule matches gets none; a later start keeps what the first start got
//   Scenario: a paths rule gives its skill at the start and keeps its paths for the done check; the deletes the job's approved text allows
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Executor } from '../../src/domain/ports.ts';
import type { DomainEvent } from '../../src/domain/types.ts';
import { allowedDeletesOfJob, doneCriteriaOfJob, jobSkillsOf, type SkillLibraryView } from '../../src/skill-library/index.ts';
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
  const root = mkdtempSync(join(tmpdir(), 'hopper-conditional-skill-'));
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
  connectGitHub(app, ['octo/infra', 'octo/site']);
  return { app, root, held: h.held, rules, token: await app.login() };
}

type T = Awaited<ReturnType<typeof start>>;
const choose = (t: T, body: unknown) => t.app.ui<SkillLibraryView & { error?: string }>('/ui/api/work-skills', body, { token: t.token });
const eventsOf = (t: T, type: string): DomainEvent[] => t.app.user().store.events.recent(1000).filter((e) => e.type === type);

/** A job of `repo` that ran on the fresh machine: its variables and its job rules. Ended, so its lane frees. */
async function running(t: T, repo: string, labels: string[] = []) {
  const job = await t.app.pull({}, { executor: 'holder', repo, labels });
  const env = await waitFor(async () => t.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  t.held.get(job.id)!.end();
  await t.app.waitForStatus(job.id, 'finished');
  return { job, env, rules: t.rules.get(job.id) ?? '' };
}

describe('conditional skills (issue #1924)', () => {
  it('an admin sets the skill rules; a rule naming no skill in the library or no condition is refused; a named skill stays', async () => {
    const t = await start();
    expect((await choose(t, { rules: [{ skill: 'nope', labels: ['iac'] }] })).status).toBe(404);
    expect((await choose(t, { rules: [{ skill: 'iac' }] })).status).toBe(400);
    expect((await choose(t, { rules: [{ skill: 'iac', repos: ['infra'] }] })).status).toBe(400);
    const set = await choose(t, { rules: [{ skill: 'iac', repos: ['Octo/Infra'] }, { skill: 'iac', labels: ['iac'] }] });
    expect(set.status, set.body.error).toBe(200);
    expect(set.body.workSkills.rules).toEqual([{ skill: 'iac', repos: ['octo/infra'] }, { skill: 'iac', labels: ['iac'] }]);
    expect(set.body.skills.find((s) => s.name === 'iac')).toMatchObject({ builtIn: true });
    // A change of the work skills keeps the rules; an empty list removes them.
    expect((await choose(t, { kinds: { code: 'work' } })).body.workSkills.rules).toHaveLength(2);
    const [last] = eventsOf(t, 'work_skills.changed');
    expect(last!.data).toMatchObject({ to: { kinds: { code: 'work' }, rules: [{ skill: 'iac' }, { skill: 'iac' }] } });
    expect((await choose(t, { rules: [] })).body.workSkills).toEqual({ kinds: { code: 'work' }, repos: {} });
  });

  it('a job a rule matches gets the skill beside its work skill: files, index, its line, and why on its timeline; others get none', async () => {
    const t = await start();
    await t.app.ui('/ui/api/skill-library', { action: 'create', name: 'gitops', files: { 'SKILL.md': 'Flag production overlays.' } }, { token: t.token });
    await choose(t, { rules: [{ skill: 'iac', repos: ['octo/infra'] }, { skill: 'iac', labels: ['iac'] }, { skill: 'gitops', labels: ['gitops'], kinds: ['code'] }] });

    const iac = await running(t, 'octo/infra', ['hopper', 'IaC']);
    const dir = `/work/.worktrees/@scratch/${iac.job.id}/credentials/conditional-skill`;
    expect(iac.env.HOPPER_CONDITIONAL_SKILLS).toBe(`${dir}/INDEX.md`);
    expect(readFileSync(join(t.root, iac.env.HOPPER_CONDITIONAL_SKILLS!), 'utf8')).toMatch(/`iac\/SKILL\.md` .*because of repository octo\/infra, label iac\. The hopper checks before the job is done: every check named \*plan\* passed/);
    expect(readFileSync(join(t.root, `${dir}/iac/SKILL.md`), 'utf8')).toMatch(/^---\nname: iac\n/);
    expect(JSON.parse(readFileSync(join(t.root, `${dir}/iac/done.json`), 'utf8')).criteria).toHaveLength(2);
    expect(iac.rules).toMatch(/\[hopper work skill\] .*\n\[hopper conditional skills\] Because of what this job works on, it also has these skills: iac, version [0-9a-f]{16} \(repository octo\/infra, label iac\)\..* The hopper checks before the job is done: iac: every check named \*plan\* passed; no terraform plan of the checks named \*plan\* destroys or replaces a resource\.$/);
    const [chosen] = eventsOf(t, 'job.conditional_skills_chosen');
    expect(chosen).toMatchObject({ jobId: iac.job.id, data: { skills: [{ name: 'iac', seq: 0, why: ['repository octo/infra', 'label iac'], done: [{ kind: 'checks-passed', checks: '*plan*' }, { kind: 'plan-destroy', checks: '*plan*' }] }] } });
    expect(doneCriteriaOfJob(t.app.user().store, iac.job.id)).toEqual([{ skill: 'iac', done: [{ kind: 'checks-passed', checks: '*plan*' }, { kind: 'plan-destroy', checks: '*plan*' }] }]);

    // The gitops rule needs its label and code work: research with the label gets none of it.
    const research = await running(t, 'octo/site', ['gitops', 'hopper:research']);
    expect(research.env.HOPPER_CONDITIONAL_SKILLS).toBeUndefined();
    expect(research.rules).not.toContain('[hopper conditional skills]');
    const gitops = await running(t, 'octo/site', ['gitops']);
    expect(readFileSync(join(t.root, gitops.env.HOPPER_CONDITIONAL_SKILLS!.replace('INDEX.md', 'gitops/SKILL.md')), 'utf8')).toBe('Flag production overlays.');
    expect(eventsOf(t, 'job.conditional_skills_chosen').map((e) => e.jobId)).toEqual([gitops.job.id, iac.job.id]);
    expect(doneCriteriaOfJob(t.app.user().store, gitops.job.id)).toEqual([]);
  });

  it('each later start keeps what the first start got, after the rules change', async () => {
    const t = await start();
    await choose(t, { rules: [{ skill: 'iac', labels: ['iac'] }] });
    const { store } = t.app.user();
    const job = { id: 'j-kept', spec: {}, source: { repo: 'octo/infra', labels: ['iac'] } } as Parameters<typeof jobSkillsOf>[1];
    const first = jobSkillsOf(store, job);
    expect(first.conditional.map((c) => c.chosen.name)).toEqual(['iac']);
    await choose(t, { rules: [] });
    expect(jobSkillsOf(store, job).conditional.map((c) => c.chosen)).toEqual(first.conditional.map((c) => c.chosen));
    expect(eventsOf(t, 'job.conditional_skills_chosen')).toHaveLength(1);
    expect(jobSkillsOf(store, { ...job, id: 'j-next' }).conditional).toEqual([]);
  });

  it('a paths rule gives its skill at the start, its paths kept for the done check; a rule with none makes it apply always', async () => {
    const t = await start();
    await choose(t, { rules: [{ skill: 'iac', paths: ['*.tf'] }, { skill: 'iac', repos: ['octo/site'] }] });
    const { store } = t.app.user();
    const infra = { id: 'j-paths', spec: {}, source: { repo: 'octo/infra' } } as Parameters<typeof jobSkillsOf>[1];
    expect(jobSkillsOf(store, infra).conditional.map((c) => c.chosen)).toMatchObject([{ name: 'iac', why: ['paths *.tf'], paths: ['*.tf'] }]);
    expect(doneCriteriaOfJob(store, 'j-paths')).toMatchObject([{ skill: 'iac', paths: ['*.tf'] }]);
    const site = { id: 'j-site', spec: {}, source: { repo: 'octo/site' } } as Parameters<typeof jobSkillsOf>[1];
    const [both] = jobSkillsOf(store, site).conditional.map((c) => c.chosen);
    expect(both).toMatchObject({ name: 'iac', why: ['paths *.tf', 'repository octo/site'] });
    expect(both!.paths).toBeUndefined();
  });

  it('the deletes a job may make are the ones its approved text allows by address, never the live issue\'s', async () => {
    const t = await start();
    const { store } = t.app.user();
    const job = await t.app.pull({}, { executor: 'holder', repo: 'octo/infra', key: 'https://github.com/octo/infra/issues/7' });
    expect(allowedDeletesOfJob(store, job.id)).toEqual([]);
    store.itemSnapshots.put({
      key: 'https://github.com/octo/infra/issues/7', title: 'Remove the bucket', body: 'Allowed deletes: `aws_s3_bucket.logs`',
      comments: [{ author: 'owner', at: '2026-10-18T00:00:00.000Z', body: '- not a list here' }], hash: 'h', recordedAt: '2026-10-18T00:00:00.000Z', reason: 'intake',
    });
    expect(allowedDeletesOfJob(store, job.id)).toEqual(['aws_s3_bucket.logs']);
    t.held.get(job.id)?.end();
  });
});
