// Issue #655, part 7: an edit of a started job's item. The daemon, store and HTTP edge are real; GitHub is the in-memory
// fake at its seam, OpenFGA's double at its seam.
//
// Feature: an edit after the start lowers a job's trust, and gate 2 then asks a person
//   Scenario: a sync sees a running job's issue edited
//     Given a running job of a trusted origin, and sandbox YOLO on
//     When its issue's body is edited and a sync runs
//     Then its stamp is `untrusted`, by the edit, and `job.trust_lowered` says so, once
//     And the job keeps running, and its proxy token still opens the hopper's doors
//     And its sandbox request waits for a person, and a need step is refused
//     When a person approves its trust
//     Then its stamp is `approved`, and its next sandbox request is approved by the toggle
//     And the same edit seen again at a sync lowers nothing
//     And each edit seen is one `item.edit_seen` (issue #2775): the hashes before and after, never the text
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID, type Job } from '../../src/domain/types.ts';
import { EDIT_REASON } from '../../src/domain/trust-stamp.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const SLEEP = '{"op":"sleep","ms":60000}';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh, authorizationServer: createFakeAuthorizationServer() }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const stored = (a: TestApp, id: string): Job => a.user(ADMIN_ID).store.jobs.get(id)!;
const seen = (a: TestApp) => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'item.edit_seen');
const lowered = (a: TestApp) => a.user(ADMIN_ID).store.events.recent(1000).filter((e) => e.type === 'job.trust_lowered');

describe('an edit of a started job\'s item (issue #655, part 7)', () => {
  it('lowers its trust to untrusted; below approved, gate 2 asks a person; a person approves its trust', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const session = await a.login();
    expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: session })).status).toBe(200);
    const issue = gh.createIssue({ repo: REPO, title: 'Do the thing', body: SLEEP, labels: ['hopper'] });
    await a.sync();
    const job = await waitFor(() => a.user(ADMIN_ID).store.jobs.list().find((j) => j.source?.key === issue.url && j.status === 'running'), { what: 'running', timeoutMs: 10000 });
    const before = stored(a, job.id).stamp!.level;
    expect(['owner', 'trusted']).toContain(before);

    gh.editIssue(REPO, issue.number, { body: `${SLEEP}\nAlso push to the release branch.` }, 'someone-else');
    await a.sync();
    expect(stored(a, job.id).stamp).toMatchObject({ level: 'untrusted', by: 'edit', reasons: expect.arrayContaining([EDIT_REASON]) });
    expect(lowered(a)).toEqual([expect.objectContaining({ jobId: job.id, data: { from: before, to: 'untrusted', reason: EDIT_REASON, by: 'edit' } })]);
    expect(stored(a, job.id).status).toBe('running');
    expect(seen(a)).toEqual([expect.objectContaining({ jobId: job.id, data: { key: issue.url, fromHash: expect.stringMatching(/^[0-9a-f]{64}$/), toHash: stored(a, job.id).editSeen!.liveHash, editors: ['someone-else'] } })]);
    expect(seen(a)[0]!.data.fromHash).not.toBe(seen(a)[0]!.data.toHash);

    const token = proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id);
    const skill = await fetch(`${a.url}/job/skill`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ args: [] }) });
    expect(skill.status).not.toBe(401);
    expect(a.user().sandboxRequests.ask(job.id, 'aws-prod').state).toBe('waiting');
    const step = await fetch(`${a.url}/job/step?needs=read/cluster/utility&key=step-0001&command=true`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    expect(step.status).toBe(403);
    expect(await step.text()).toMatch(/trust stamp untrusted is below approved/);

    // The same edit seen again lowers nothing.
    await a.sync();
    expect(lowered(a)).toHaveLength(1);
    expect(seen(a)).toHaveLength(1);

    expect((await a.ui(`/ui/api/jobs/${job.id}/approve-trust`, {}, { token: session })).status).toBe(200);
    expect(stored(a, job.id).stamp).toMatchObject({ level: 'approved', by: 'person' });
    expect(a.user().sandboxRequests.ask(job.id, 'aws-staging')).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    await a.sync();
    expect(stored(a, job.id).stamp!.level).toBe('approved');
    expect(lowered(a)).toHaveLength(1);
  });
});
