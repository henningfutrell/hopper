// Usage and accounts through the real daemon (design.md "Usage and accounts (issue #18)"):
// the claude-plan usage source against a fake `claude` (never the real one) throttles lanes
// through the decider; GET /api/usage reports readings, source states, limits and the lane
// effect per machine; GET /api/accounts names who each part acts as — the Claude account and
// the GitHub identities of the job sources — and never a token.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, PartAccount, UsageReport } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { appSecrets, BOT, jobSourcesDoc } from '../support/github-app.ts';
import { waitFor } from '../support/wait.ts';

const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude-plan.mjs');
const REPO = 'owner/hopper-sandbox';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
const saved = process.env.FAKE_PLAN_DIR;
let control: string;

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-fake-plan-'));
  process.env.FAKE_PLAN_DIR = control;
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
});

/** `Oct 5, 9am (UTC)` two days from now, so no window has reset during the test. */
function resetsIn2Days(): string {
  const d = new Date(Date.now() + 2 * 86_400_000);
  return `${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCDate()}, 9am (UTC)`;
}

type Plugins = Record<string, unknown>;

async function boot(o: { plugins: Plugins; secrets?: Record<string, string | undefined>; seams?: Parameters<typeof startTestApp>[0]['seams'] }) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, plugins: o.plugins, ...(o.secrets ? { secrets: o.secrets } : {}), ...(o.seams ? { seams: o.seams } : {}) });
  apps.push(a);
  return a;
}

const usage = async (a: TestApp) => (await a.api<UsageReport>('GET', '/api/usage')).body;
const accounts = async (a: TestApp) => (await a.api<{ accounts: PartAccount[] }>('GET', '/api/accounts')).body.accounts;

describe('claude-plan through the composition root', () => {
  it('a session at 80% caps 4 lanes at 2; the week of one model at 99% does not throttle; GET /api/usage says so', async () => {
    const when = resetsIn2Days();
    writeFileSync(join(control, 'result.txt'), [
      'You are currently using your subscription to power your Claude Code usage', '',
      `Current session: 80% used · resets ${when}`,
      `Current week (all models): 30% used · resets ${when}`,
      `Current week (Fable): 99% used · resets ${when}`,
    ].join('\n'));
    const a = await boot({ plugins: { machines: lanes(4), usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: FAKE_CLAUDE } }] } });

    const report = await waitFor(async () => { const u = await usage(a); return u.readings.some((r) => r.source === 'claude') && u.sources[0]?.account ? u : undefined; }, { what: 'claude readings and account' });
    expect(report.readings.filter((r) => r.source === 'claude').map((r) => [r.window, r.used, r.limit, r.unit, r.informational ?? false])).toEqual([
      ['session', 80, 100, '%', false], ['week', 30, 100, '%', false], ['week (Fable)', 99, 100, '%', true],
    ]);
    expect(report.sources).toEqual([
      { name: 'claude', refreshedAt: expect.any(String), account: { service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai' } } },
      { name: 'fake' },
    ]);
    expect(report.limits).toEqual({ soft: 0.7, hard: 0.95 });
    expect(report.machines).toEqual([{ machineId: 'local', label: expect.any(String), online: true, maxLanes: 4, usedFrac: 0.8, cap: 2, band: 'soft' }]);

    const jobs: Job[] = [];
    for (let i = 0; i < 4; i++) jobs.push(await a.pull({ op: 'sleep', ms: 3000 }));
    await waitFor(async () => (await a.api('GET', '/api/queue')).body.running.length === 2, { what: 'two running' });
    const held = await a.waitForStatus(jobs[3]!.id, 'held');
    expect(held.holdReason).toContain('usage soft limit caps lanes at 2');
    expect((await a.api('GET', '/api/queue')).body.running).toHaveLength(2);

    const plugins = (await a.api('GET', '/api/plugins')).body;
    expect(plugins.usageSources.instances).toEqual([expect.objectContaining({ instance: expect.objectContaining({ name: 'claude', plugin: 'claude-plan' }), active: 'claude-plan' })]);
  });

  it('GET /api/accounts: the Claude account the usage source reads for — email, plan, organization; never an id or a token', async () => {
    const a = await boot({ plugins: { usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: FAKE_CLAUDE } }] } });
    const list = await waitFor(async () => { const l = await accounts(a); return l.some((x) => x.service === 'claude') ? l : undefined; }, { what: 'the claude account' });
    expect(list).toEqual([{ role: 'usage-source', instance: 'claude', service: 'claude', identity: 'user@example.com', detail: { plan: 'max', organization: 'Example Org', authMethod: 'claude.ai' } }]);
    const raw = JSON.stringify(await a.api('GET', '/api/accounts'));
    expect(raw).not.toContain('SECRET');
    expect(raw).not.toContain('org-1');
  });

  it('claude unavailable: no claude readings, the reason in GET /api/usage, lanes uncapped', async () => {
    writeFileSync(join(control, 'mode'), 'header-only');
    const a = await boot({ plugins: { machines: lanes(4), usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { bin: FAKE_CLAUDE } }] } });
    const report = await waitFor(async () => { const u = await usage(a); return u.sources[0]?.problem !== 'not read yet' ? u : undefined; }, { what: 'the first read' });
    expect(report.sources[0]).toMatchObject({ name: 'claude', problem: expect.stringMatching(/^usage unavailable: /) });
    expect(report.readings.filter((r) => r.source === 'claude')).toEqual([]);
    expect(report.machines[0]).toMatchObject({ cap: 4, band: 'free' });
  });
});

describe('GitHub accounts of the job sources', () => {
  it('the app source acts as its bot on its installation repos; the gh source paused by the app says so', async () => {
    const gh = createFakeGitHub();
    const app = createFakeGitHub({ app: { botLogin: BOT, installedRepos: [REPO] } });
    const a = await boot({ plugins: { jobSources: jobSourcesDoc() }, secrets: appSecrets(), seams: { github: gh, githubApp: app } });
    await a.sync();
    const list = await accounts(a);
    expect(list).toContainEqual({ role: 'job-source', instance: 'github-app', service: 'github', identity: BOT, detail: { via: 'GitHub App', installedRepos: [REPO] } });
    expect(list).toContainEqual({ role: 'job-source', instance: 'github', service: 'github', detail: { via: 'gh CLI' }, problem: 'GitHub App configured' });
  });

  it('the gh source names the gh user once it has asked who that is', async () => {
    const gh = createFakeGitHub({ login: 'owner' });
    const a = await boot({ plugins: { jobSources: jobSourcesDoc({ github: { enabled: true } }) }, seams: { github: gh } });
    await a.sync();
    expect(await accounts(a)).toContainEqual({ role: 'job-source', instance: 'github', service: 'github', identity: 'owner', detail: { via: 'gh CLI' } });
  });
});
