// Issue #2228, end to end through the real daemon against the fake GitHub at its seam: each entry of a source's intake
// says when the hopper first listed its item (`arrivedAt`, ISO 8601), kept in the database, so a sync after it and a
// restart of the hopper keep the time the card arrived.
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

async function boot(dbPath: string, gh: FakeGitHub) {
  const plugins = {
    machines: lanes(2),
    jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }],
  };
  const a = await startTestApp({ dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const intake = async (a: TestApp): Promise<Record<string, IntakeOutcome>> =>
  Object.fromEntries(((await a.api('GET', '/api/sources')).body.sources.find((s: { name: string }) => s.name === 'github').detail.intake as IntakeOutcome[]).map((x) => [x.key, x]));
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('each intake card says when it arrived (issue #2228)', () => {
  it('carries the time the hopper first listed the item, kept at the next sync', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const a = await boot(db.dbPath, gh);
    const before = new Date().toISOString();
    const card = gh.createIssue({ repo: REPO, title: 'From outside', body: 'Please do the thing.', author: 'stranger', labels: ['hopper'] });
    await a.sync();
    const first = (await intake(a))[card.url]!;
    expect(first.group).toBe('request');
    expect(first.arrivedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(first.arrivedAt! >= before).toBe(true);

    await tick();
    await a.sync();
    expect((await intake(a))[card.url]!.arrivedAt).toBe(first.arrivedAt);

    const later = gh.createIssue({ repo: REPO, title: 'Later', body: 'And this.', author: 'stranger', labels: ['hopper'] });
    await tick();
    await a.sync();
    const now = await intake(a);
    expect(now[card.url]!.arrivedAt).toBe(first.arrivedAt);
    expect(now[later.url]!.arrivedAt! > first.arrivedAt!).toBe(true);
  });

  it('a restart of the hopper keeps the time each card arrived', async () => {
    const db = tempDbPath(); cleanup = db.cleanup;
    const gh = createFakeGitHub();
    const first = await boot(db.dbPath, gh);
    const card = gh.createIssue({ repo: REPO, title: 'From outside', body: 'Please do the thing.', author: 'stranger', labels: ['hopper'] });
    await first.sync();
    const arrived = (await intake(first))[card.url]!.arrivedAt;
    expect(arrived).toBeDefined();
    await first.stop(); apps.splice(apps.indexOf(first), 1);

    await tick();
    const second = await boot(db.dbPath, gh);
    await second.sync();
    expect((await intake(second))[card.url]!.arrivedAt).toBe(arrived);
  });
});
