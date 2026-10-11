// Issue #808, end to end through the real daemon against the fake GitHub at its seam: an issue on the backburner says
// since when and by whom it is there — the newest `labeled` event of `hopper:backburner` —, so Not taken can show its age
// and who put it there. Its events are read once while the label stays; put on the backburner again, it is read again.
import { afterEach, describe, expect, it } from 'vitest';
import type { IntakeOutcome } from '../../src/domain/intake.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

async function boot(gh: FakeGitHub) {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = {
    machines: lanes(2),
    jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }],
  };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const sleepy = `${JSON.stringify({ op: 'sleep', ms: 60000 })}\n\nPlease do the thing.`;
const intake = async (a: TestApp): Promise<Record<string, IntakeOutcome>> =>
  Object.fromEntries(((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).map((x) => [x.key, x]));
const eventReads = (gh: FakeGitHub, n: number) => gh.calls.filter((c) => c.method === 'issueEvents' && c.args[1] === n).length;

describe('an issue on the backburner says since when and by whom (issue #808)', () => {
  it('carries when hopper:backburner was added and who added it', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:backburner'], labelledBy: 'owner' });
    const labelled = gh.issue(REPO, issue.number).updatedAt;
    await a.sync();
    expect((await intake(a))[issue.url]).toMatchObject({ group: 'backburner', backburner: { since: labelled, by: 'owner' } });
  });

  it('reads the events once while the label stays, and again when the issue goes back on the backburner', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:backburner'], labelledBy: 'owner' });
    await a.sync();
    await a.sync();
    expect(eventReads(gh, issue.number)).toBe(1);
    const first = (await intake(a))[issue.url]!.backburner!.since!;

    gh.removeLabel(REPO, issue.number, 'hopper:backburner');
    await a.sync();
    expect((await intake(a))[issue.url]!.backburner).toBeUndefined();
    gh.addLabel(REPO, issue.number, 'hopper:backburner', 'helper');
    await a.sync();
    const again = (await intake(a))[issue.url]!.backburner!;
    expect(again.by).toBe('helper');
    expect(again.since! > first).toBe(true);
  });

  it('an issue whose events cannot be read is still listed, with no since, and is read again next sync', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = gh.createIssue({ repo: REPO, body: sleepy, labels: ['hopper', 'hopper:backburner'], labelledBy: 'owner' });
    gh.failNext('issueEvents', new Error('boom'));
    await a.sync();
    const o = (await intake(a))[issue.url]!;
    expect(o).toMatchObject({ group: 'backburner', action: 'unbackburner' });
    expect(o.backburner).toBeUndefined();
    await a.sync();
    expect((await intake(a))[issue.url]!.backburner).toMatchObject({ by: 'owner' });
  });
});
