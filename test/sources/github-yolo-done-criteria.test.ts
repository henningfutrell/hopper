// Yolo mode reads the done criteria before it merges (issue #1924 part 3): a job's own pull request that is ready by its
// checks is not merged by the hopper while a done criterion of the job's conditional skills is not met on it now, or while a
// `person-merges` criterion applies to it (the gitops skill: a production overlay change is a deploy on merge). The hold is
// kept on what is seen (`mergeError`) and asked again at the next sync. A person's Merge now still merges.
import { describe, expect, it } from 'vitest';
import type { DoneCriterion } from '../../src/domain/conditional-skills.ts';
import { REPO, jobForIssue, setup } from './fixtures/github-support.ts';

const LONG_AGO = '2026-10-02T09:50:00.000Z';
const IAC: DoneCriterion[] = [{ kind: 'checks-passed', checks: '*plan*' }, { kind: 'plan-destroy', checks: '*plan*' }];
const GITOPS: DoneCriterion[] = [{ kind: 'person-merges', paths: ['**/overlays/production/**'] }];
const plan = (destroy: number) => `Terraform will perform the following actions\n\nPlan: 1 to add, 0 to change, ${destroy} to destroy.`;

async function ended(done: DoneCriterion[] | undefined, skill = 'iac', o: { files?: string[]; paths?: string[] } = {}) {
  const s = setup({}, {
    yoloMode: () => true,
    ...(done ? { doneCriteria: () => [{ skill, done, ...(o.paths ? { paths: o.paths } : {}) }] } : {}),
  });
  s.gh.createIssue({ repo: REPO, labels: ['hopper'] });
  const pr = s.gh.openPullRequest(REPO, 1, { createdAt: LONG_AGO, checks: 'passing', ...(o.files ? { files: o.files } : {}) });
  const base = jobForIssue(1, { status: 'finished', createdAt: '2026-10-02T09:00:00.000Z' });
  const state = await s.source.report({ kind: 'finished', job: base });
  return { ...s, pr, job: { ...base, sourceState: { source: state } } };
}

const merges = (gh: Awaited<ReturnType<typeof ended>>['gh']) => gh.calls.filter((c) => c.method === 'merge').length;

describe('yolo mode reads the done criteria before it merges (issue #1924 part 3)', () => {
  it('a plan that replaces a resource holds the merge, though every check is green; the hold says why', async () => {
    const { gh, source, job, pr } = await ended(IAC);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (control-plane)', state: 'passing', text: plan(1) }]);
    const up = await source.follow!(job);
    expect(up).toMatchObject({ outcome: 'open', state: { seen: { mergeError: expect.stringMatching(/^done criteria of skill iac not met: a terraform plan destroys or replaces 1 resource/) } } });
    expect(merges(gh)).toBe(0);
  });

  it('the criteria met at the next sync: the hopper merges it', async () => {
    const { gh, source, job, pr } = await ended(IAC);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text: plan(1) }]);
    const held = await source.follow!(job);
    gh.setCheckRuns(pr.url, [{ name: 'terraform plan (prod)', state: 'passing', text: plan(0) }]);
    expect(await source.follow!({ ...job, sourceState: { source: held!.state } })).toMatchObject({ outcome: 'merged', byHopper: true });
    expect(merges(gh)).toBe(1);
  });

  it('a job with no conditional skill, or a skill whose paths the change does not touch, merges as before', async () => {
    const none = await ended(undefined);
    expect(await none.source.follow!(none.job)).toMatchObject({ outcome: 'merged' });
    const other = await ended(IAC, 'iac', { paths: ['*.tf'], files: ['src/app.ts'] });
    expect(await other.source.follow!(other.job)).toMatchObject({ outcome: 'merged' });
  });

  it('a person-merges criterion holds a change to the paths it names: a person merges it, never the hopper', async () => {
    const { gh, source, job } = await ended(GITOPS, 'gitops', { files: ['apps/web/overlays/production/kustomization.yaml'] });
    expect(await source.follow!(job)).toMatchObject({ outcome: 'open', state: { seen: { mergeError: 'done criteria of skill gitops: a person merges a change to **/overlays/production/**, not the hopper' } } });
    expect(merges(gh)).toBe(0);
  });

  it('a person-merges criterion lets the hopper merge a change outside its paths, but holds one whose files are not known', async () => {
    const outside = await ended(GITOPS, 'gitops', { files: ['apps/web/overlays/staging/kustomization.yaml'] });
    expect(await outside.source.follow!(outside.job)).toMatchObject({ outcome: 'merged' });
    const unknown = await ended(GITOPS, 'gitops');
    expect(await unknown.source.follow!(unknown.job)).toMatchObject({ outcome: 'open', state: { seen: { mergeError: expect.stringMatching(/a person merges/) } } });
  });

  it("a person's Merge now still merges a held pull request", async () => {
    const { gh, source, job } = await ended(GITOPS, 'gitops', { files: ['overlays/production/app.yaml'] });
    const held = await source.follow!(job);
    expect(await source.follow!({ ...job, sourceState: { source: held!.state } }, 'merge')).toMatchObject({ outcome: 'merged' });
    expect(merges(gh)).toBe(1);
  });

  it('the done check does not take person-merges as a miss: the job is done once its pull request is ready', async () => {
    const { source, job } = await ended(GITOPS, 'gitops', { files: ['overlays/production/app.yaml'] });
    expect(await source.notComplete!({ ...job, status: 'running' })).toBeUndefined();
  });
});
