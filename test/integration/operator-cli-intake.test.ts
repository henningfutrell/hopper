// Issue #2220: request cards from the operator CLI. `hopper intake list` lists the open request cards, each with its
// source, key, hash and why it is a request; `hopper intake approve|decline <key>` is the Intake page's Approve and
// Decline, on the same route: the same hash check against the last sync, the same events with `via: cli`, and the same
// permission check, so a grant without the intake scope is refused. `--as <person>` names who decided, and nothing more.
// Real daemon, real HTTP server, real CLI; GitHub is the fake, OpenFGA the double.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { Job } from '../../src/domain/types.ts';
import { createFakeGitHub, type FakeGitHub } from '../../src/sources/index.ts';
import { databaseUrlFor } from '../support/database.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/hopper-sandbox';
const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(gh: FakeGitHub): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  const a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: gh }, plugins });
  apps.push(a);
  connectGitHub(a, [REPO]);
  return a;
}

const body = (text: string) => `${JSON.stringify({ op: 'sleep', ms: 10000 })}\n\n${text}`;
const jobsFor = async (a: TestApp, url: string): Promise<Job[]> =>
  (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs.filter((j) => j.source?.key === url);

async function hopper(a: TestApp, argv: string[], env: Record<string, string> = { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { ...env, HOPPER_URL: a.url }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli(argv, io);
  const text = out.join('');
  return { code, err: err.join(''), json: text ? JSON.parse(text) as unknown : undefined };
}

/** A stranger's issue, labelled: a request card after the sync. */
async function card(a: TestApp, gh: FakeGitHub, text = 'Fix the typo.') {
  const issue = gh.createIssue({ repo: REPO, author: 'stranger', body: body(text), labels: ['hopper'], labelledBy: 'owner', assignedBy: 'owner' });
  await a.sync();
  return issue;
}

/** A grant of `scopes` (or a preset), its refresh token in a file of its own: the CLI then acts with it, no database. */
async function grantFile(a: TestApp, mint: Record<string, unknown>): Promise<Record<string, string>> {
  const r = await a.ui<{ refresh: string }>('/ui/api/api-tokens', { action: 'mint', label: 'cos', days: 1, ...mint }, { token: await a.login() });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const dir = mkdtempSync(join(tmpdir(), 'hopper-intake-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'refresh');
  writeFileSync(file, `${r.body.refresh}\n`, { mode: 0o600 });
  return { HOPPER_REFRESH_TOKEN_FILE: file };
}

describe('request cards from the operator CLI (issue #2220)', () => {
  it('intake list gives each open request card: its source, key, hash and why it is a request', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = await card(a, gh);
    const listed = await hopper(a, ['intake', 'list']);
    expect(listed.code, listed.err).toBe(0);
    expect(listed.json).toEqual([expect.objectContaining({
      source: 'github', key: issue.url, repo: REPO, hash: expect.stringMatching(/^[0-9a-f]{64}$/), author: 'stranger', why: ['written by stranger, not a trusted actor'],
    })]);
  });

  it('intake approve approves the text of the last sync, as the Intake page does: one job, the event via cli, by --as', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = await card(a, gh);
    const { hash } = ((await hopper(a, ['intake', 'list'])).json as { hash: string }[])[0]!;
    const approved = await hopper(a, ['intake', 'approve', issue.url, '--as', 'chief-of-staff']);
    expect(approved.code, approved.err).toBe(0);
    expect(approved.json).toEqual({ done: [issue.url], failed: {} });
    const [job] = await waitFor(async () => { const js = await jobsFor(a, issue.url); return js.length ? js : undefined; }, { what: 'the approved job' });
    expect(job).toMatchObject({ source: { origin: 'approved', author: 'stranger' }, spec: { payload: { body: body('Fix the typo.') } } });
    expect((await a.events('types=source.request_approved')).map((e) => e.data)).toEqual([expect.objectContaining({
      source: 'github', key: issue.url, hash, author: 'stranger', person: 'chief-of-staff', via: 'cli',
    })]);
    expect((await hopper(a, ['intake', 'list'])).json).toEqual([]);
  });

  it('intake approve of text edited since the last sync approves nothing: the card is listed again with the new text', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = await card(a, gh);
    const { hash } = ((await hopper(a, ['intake', 'list'])).json as { hash: string }[])[0]!;
    const stale = await hopper(a, ['intake', 'approve', issue.url, '--hash', 'a'.repeat(64)]);
    // Not done: the answer names why, and the exit code says so.
    expect(stale.code).toBe(2);
    expect(stale.json).toMatchObject({ done: [], failed: { [issue.url]: expect.any(String) } });
    expect(await a.events('types=source.request_approved')).toEqual([]);
    expect(((await hopper(a, ['intake', 'list'])).json as { hash: string }[])[0]!.hash).toBe(hash);
  });

  it('intake decline --close declines the card as the Intake page does: the event via cli, the issue closed', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = await card(a, gh);
    const declined = await hopper(a, ['intake', 'decline', issue.url, '--close']);
    expect(declined.code, declined.err).toBe(0);
    expect((await a.events('types=source.request_declined')).map((e) => e.data)).toEqual([expect.objectContaining({ source: 'github', key: issue.url, choice: 'close', via: 'cli' })]);
    await waitFor(async () => (await a.events('types=source.request_decline_written')).length === 1 || undefined, { what: 'the decline written' });
    expect(gh.issue(REPO, issue.number)).toMatchObject({ state: 'closed', stateReason: 'not_planned' });
    expect(await jobsFor(a, issue.url)).toEqual([]);
  });

  it('a key that is no open request card, or a bad call, is a refusal', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    await card(a, gh);
    expect((await hopper(a, ['intake', 'approve', 'https://github.com/owner/hopper-sandbox/issues/999'])).code).toBe(2);
    expect((await hopper(a, ['intake', 'decline', 'k', '--close', '--open'])).code).toBe(2);
    expect((await hopper(a, ['intake', 'approve'])).code).toBe(2);
    expect((await hopper(a, ['intake', 'list', '--as', 'x'])).code).toBe(2);
  });

  it('a grant without the intake scope lists the cards but is refused Approve; one with it approves, via api', async () => {
    const gh = createFakeGitHub();
    const a = await boot(gh);
    const issue = await card(a, gh);
    const reader = await grantFile(a, { preset: 'read-only' });
    expect((await hopper(a, ['intake', 'list'], reader)).json).toHaveLength(1);
    const refused = await hopper(a, ['intake', 'approve', issue.url], reader);
    expect(refused.code).toBe(2);
    expect(refused.err).toMatch(/refused \(403\)/);
    expect(await a.events('types=source.request_approved')).toEqual([]);
    // --as is the CLI session's: a grant already names who acts.
    expect((await hopper(a, ['intake', 'approve', issue.url, '--as', 'someone'], reader)).code).toBe(2);

    const intake = await grantFile(a, { preset: 'agent-intake' });
    const approved = await hopper(a, ['intake', 'approve', issue.url], intake);
    expect(approved.code, approved.err).toBe(0);
    expect((await a.events('types=source.request_approved')).map((e) => e.data)).toEqual([expect.objectContaining({ key: issue.url, via: 'api' })]);
  });
});
