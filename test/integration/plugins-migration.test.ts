// Phase 5 slice 4 through the real composition root: the boot that finds no plugins.yaml folds
// sources.yaml and the removed part-choosing env vars into one (mode 600), renames sources.yaml,
// and the daemon then behaves as before — the GitHub source keeps its name `github`, so its jobs
// and sync state carry over. The next boot reads the file and migrates nothing. Leftover
// JOB_HOPPER_* vars get a loud warning. The fake GitHub sits at the seam; never the real one.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { Job, SourceStatus } from '../../src/domain/types.ts';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, writePluginsYaml, type TestApp } from '../support/app.ts';
import { writeSourcesFile } from '../support/files.ts';
import { waitFor } from '../support/wait.ts';

const REPO = 'owner/job-hopper-sandbox';
const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
  cleanup = undefined;
  vi.restoreAllMocks();
});

function newDb(): { dbPath: string; dataDir: string } {
  const db = tempDbPath();
  cleanup = db.cleanup;
  return { dbPath: db.dbPath, dataDir: dirname(db.dbPath) };
}

const SOURCES = `version: 1
github:
  enabled: true              # the owner's own comment
  pollSeconds: 3600
  repos: [${REPO}]
  authors: [owner]
  executor: scripted
  defaultCwd: /tmp
  progressCommentSeconds: 1
`;

const LEGACY_ENV = { JOB_HOPPER_LOCAL_LANES: '0', JOB_HOPPER_EXECUTORS: 'test', JOB_HOPPER_GH_BIN: '/nonexistent/gh' };

const jobsOf = async (a: TestApp): Promise<Job[]> => (await a.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=1000')).body.jobs;
const status = async (a: TestApp, name: string): Promise<SourceStatus | undefined> =>
  (await a.api<{ sources: SourceStatus[] }>('GET', '/api/sources')).body.sources.find((s) => s.name === name);

describe('the first boot without plugins.yaml migrates', () => {
  it('writes plugins.yaml 600 from sources.yaml and the env, renames sources.yaml; the daemon behaves the same, and the next boot migrates nothing', async () => {
    const { dbPath, dataDir } = newDb();
    writeSourcesFile(dbPath, SOURCES);
    const gh = createFakeGitHub();
    const warn = vi.spyOn(console, 'warn');
    const first = await startTestApp({ dbPath, plugins: false, env: LEGACY_ENV, seams: { github: gh } });
    apps.push(first);

    const pluginsFile = join(dataDir, 'plugins.yaml');
    expect(statSync(pluginsFile).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dataDir, 'sources.yaml'))).toBe(false);
    expect(readFileSync(join(dataDir, 'sources.yaml.migrated'), 'utf8')).toBe(SOURCES);
    const doc = parse(readFileSync(pluginsFile, 'utf8'));
    expect(doc.jobSources.map((s: { name: string; plugin: string }) => [s.name, s.plugin])).toEqual([['github', 'github-gh'], ['github-app', 'github-app']]);
    expect(doc.machines).toEqual({ name: 'local', plugin: 'local', options: { lanes: 0 } });
    expect(doc.executors).toEqual([{ name: 'test', plugin: 'test' }]);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/JOB_HOPPER_EXECUTORS/);
    expect(warned).toMatch(/JOB_HOPPER_GH_BIN/);
    expect(warned).toMatch(/JOB_HOPPER_LOCAL_LANES/);

    // Behaves as the env and sources.yaml said: no lanes, gh source pulling from the allowlisted repo.
    expect((await first.api('GET', '/api/machines')).body.machines[0]).toMatchObject({ id: 'local', maxLanes: 0 });
    expect((await first.api('GET', '/api/plugins')).body.config).toMatchObject({ source: 'file', path: pluginsFile });
    expect(await status(first, 'github')).toMatchObject({ kind: 'github', detail: expect.objectContaining({ mode: 'gh', repos: [REPO], enabledSetting: 'true' }) });
    const issue = gh.createIssue({ repo: REPO, title: 'Paint the shed', body: '{"op":"echo"}\n\nPaint it.', labels: ['hopper'] });
    await first.sync();
    const [job] = await jobsOf(first);
    expect(job).toMatchObject({ status: 'held', source: { source: 'github', key: issue.url } });
    await waitFor(() => gh.issue(REPO, issue.number).labels.includes('hopper:claimed'), { what: 'claimed label' });
    await first.stop();
    const once = readFileSync(pluginsFile, 'utf8');

    // Second boot: the file is read, nothing migrates; the same `github` source still owns the job.
    const second = await startTestApp({ dbPath, seams: { github: gh } });
    apps.push(second);
    expect(readFileSync(pluginsFile, 'utf8')).toBe(once);
    await second.sync();
    expect((await jobsOf(second)).map((j) => j.id)).toEqual([job!.id]);
    gh.closeIssue(REPO, issue.number);
    await second.sync();
    await second.waitForStatus(job!.id, 'cancelled');
    expect((await second.events('types=job.cancelled')).find((e) => e.jobId === job!.id)?.data).toEqual({ reason: 'issue closed' });
  });

  it('nothing to migrate: writes the default plugins.yaml (600) — github disabled, github-app waiting for its app file', async () => {
    const { dbPath, dataDir } = newDb();
    const a = await startTestApp({ dbPath, plugins: false });
    apps.push(a);
    expect(statSync(join(dataDir, 'plugins.yaml')).mode & 0o777).toBe(0o600);
    expect(await status(a, 'github')).toMatchObject({ state: 'disabled' });
    expect(await status(a, 'github-app')).toMatchObject({ state: 'disabled', detail: expect.objectContaining({ paused: 'no GitHub App configured' }) });
    expect((await a.api('GET', '/api/machines')).body.machines[0]).toMatchObject({ maxLanes: 4 });
  });

  it('a plugins.yaml that exists is never overwritten; a sources.yaml beside it stays and is reported as no longer read', async () => {
    const { dbPath, dataDir } = newDb();
    const text = 'version: 1\n# the owner\'s\nexecutors: [ { name: test, plugin: test } ]\njobSources: []\n';
    writePluginsYaml(dataDir, text);
    writeSourcesFile(dbPath, SOURCES);
    const warn = vi.spyOn(console, 'warn');
    const a = await startTestApp({ dbPath, env: LEGACY_ENV });
    apps.push(a);
    expect(readFileSync(join(dataDir, 'plugins.yaml'), 'utf8')).toBe(text);
    expect(readFileSync(join(dataDir, 'sources.yaml'), 'utf8')).toBe(SOURCES);
    expect(existsSync(join(dataDir, 'sources.yaml.migrated'))).toBe(false);
    expect(await status(a, 'github')).toBeUndefined();
    expect((await a.api('GET', '/api/machines')).body.machines[0]).toMatchObject({ maxLanes: 4 });
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/sources\.yaml.*no longer read/);
  });
});

describe('leftover JOB_HOPPER_* variables', () => {
  it('any set but no longer read gets one loud boot warning naming each', async () => {
    const { dbPath } = newDb();
    const warn = vi.spyOn(console, 'warn');
    const a = await startTestApp({ dbPath, env: { JOB_HOPPER_JEV_ADVISOR: 'router', JOB_HOPPER_CLAUDE_CWD: '/w', JOB_HOPPER_NOT_A_THING: '1' } });
    apps.push(a);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /no longer read/.test(l) && /JOB_HOPPER_/.test(l));
    expect(lines).toHaveLength(1);
    for (const v of ['JOB_HOPPER_CLAUDE_CWD', 'JOB_HOPPER_JEV_ADVISOR', 'JOB_HOPPER_NOT_A_THING']) expect(lines[0]).toContain(v);
  });

  it('no leftover variables: no such warning', async () => {
    const { dbPath } = newDb();
    const warn = vi.spyOn(console, 'warn');
    const a = await startTestApp({ dbPath });
    apps.push(a);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => /JOB_HOPPER_.*no longer read/.test(l))).toEqual([]);
  });
});
