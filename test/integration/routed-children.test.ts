// Issue #1510: a required child a job files on one of its user's job repositories is routed. The hopper labels it with the
// job sources' label and assigns it to the job's user, so Intake lists it as a request card (a job filed it, so it is
// never of a trusted origin: a person approves it). The job is answered the `on:` line that wakes it when the child
// closes. A follow-up stays unlabelled and unassigned, for a person to triage. The daemon, store and HTTP edge are real;
// GitHub is a fake on loopback; the job runs the real `hopper-gh` script against the hopper.
//
// Feature: routed children
//   Scenario: a job files a required child on another job repository
//     Given a job running for octo/tools#7, and octo/site a job repository too
//     When the job runs `sh "$HOPPER_GH" issue create --repo octo/site … --required`
//     Then the child carries the hopper label and the user's login as assignee, and its text says it was routed
//     And the answer says routed, and the wait line `issue octo/site#N`; the timeline's `job.child_issue_filed` says routed
//   Scenario: GitHub drops the assignee of the new child (issue #1856)
//     When GitHub files the child with its label but without the assignee
//     Then the hopper assigns it in a second call, so Intake does not list it as not assigned
//     And when GitHub drops it again, the answer and the timeline say unassigned
//   Scenario: a job files a follow-up
//     Then it carries no label and no assignee
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type DomainEvent } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh, type Run } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
});

const json = (r: Run): Record<string, unknown> => JSON.parse(r.stdout) as Record<string, unknown>;

/** A hopper working on octo/tools and octo/site, and a job running for octo/tools#7. */
async function parented() {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  cleanups.push(() => github.close());
  github.tokens.set('test-account-token', 'owner');
  github.issues.push({ repo: 'octo/tools', number: 7, title: 'Ship it in parts', body: 'Please.', author: 'owner', labels: ['hopper'] });
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const root = mkdtempSync(join(tmpdir(), 'hopper-routed-machine-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const h = holder(root);
  cleanups.push(() => { for (const j of h.held.values()) j.end(); });
  const app = await startTestApp({
    dbPath: db.dbPath,
    seams: { executors: [h.executor] },
    plugins: { executors: [{ name: 'test', plugin: 'test' }] },
    env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
  });
  apps.push(app);
  connectGitHub(app, ['octo/tools', 'octo/site']);
  const job = await app.pull({}, { executor: 'holder', repo: 'octo/tools', number: 7 }, ADMIN_ID);
  const env = await waitFor(async () => h.held.get(job.id)?.env, { what: `job ${job.id} to run` });
  return { app, github, root, job, env };
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === type);

describe('a required child is routed (issue #1510)', () => {
  it('the hopper labels it and assigns it, so Intake lists it, and the job is told what to wait on', async () => {
    const t = await parented();
    const answer = json(await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/site', '--title', 'Fix there', '--body', 'Needed.', '--required']));
    expect(answer).toMatchObject({ ok: true, parent: 'octo/tools#7', required: true, routed: true, waitOn: `issue octo/site#${String(answer.number)}` });
    const child = t.github.issues.find((i) => i.repo === 'octo/site' && i.number === answer.number)!;
    expect(child).toMatchObject({ labels: ['hopper'], assignees: ['owner'] });
    expect(child.body).toContain('Filed through hopper for job');
    expect(child.body).toContain('Routed by the hopper: Intake lists it as a request card, and a person approves it before a job takes it.');
    expect(eventsOf(t.app, 'job.child_issue_filed')).toEqual([expect.objectContaining({
      jobId: t.job.id, data: expect.objectContaining({ child: expect.objectContaining({ repo: 'octo/site', number: answer.number }), required: true, routed: true }),
    })]);
  });

  it('an assignee GitHub dropped from the new child is set again in a second call (issue #1856)', async () => {
    const t = await parented();
    t.github.dropsAssignees = ['owner'];
    const answer = json(await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/site', '--title', 'Fix there', '--body', 'Needed.', '--required']));
    expect(answer).toMatchObject({ ok: true, routed: true });
    expect(answer).not.toHaveProperty('unassigned');
    expect(t.github.issues.find((i) => i.repo === 'octo/site' && i.number === answer.number)).toMatchObject({ labels: ['hopper'], assignees: ['owner'] });
  });

  it('an assignee GitHub drops twice is told to the job and kept on the timeline, never hidden (issue #1856)', async () => {
    const t = await parented();
    t.github.dropsAssignees = ['owner'];
    t.github.unassignable = ['owner'];
    const answer = json(await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/site', '--title', 'Fix there', '--body', 'Needed.', '--required']));
    expect(answer).toMatchObject({ ok: true, routed: true, unassigned: ['owner'] });
    expect(eventsOf(t.app, 'job.child_issue_filed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ routed: true, unassigned: ['owner'] }) })]);
  });

  it('a follow-up is not routed: no label and no assignee, a person triages it', async () => {
    const t = await parented();
    const answer = json(await hopperGh(t.root, t.env, ['issue', 'create', '--repo', 'octo/site', '--title', 'Later', '--body', 'Some day.']));
    expect(answer).not.toHaveProperty('routed');
    expect(t.github.issues.find((i) => i.repo === 'octo/site' && i.number === answer.number)).toMatchObject({ labels: [], assignees: [] });
  });
});
