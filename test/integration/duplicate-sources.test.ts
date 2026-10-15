// Duplicate GitHub sources (issue #1264): a second GitHub source for the same account (or app) and repositories is
// refused, and the first stays; duplicates already configured show on GET /api/sources, each naming the source it
// duplicates, until one is removed. Each source's status says its poll interval and its calls in the last hour and day.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginsReport, SourceStatus } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { readConfig } from '../support/files.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => { await t?.stop(); t = undefined; cleanup?.(); });

const ACCOUNT = { name: 'github-account', plugin: 'github-account', options: { executor: 'test', pollSeconds: 3600 } };

async function start(jobSources: object[]): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, realRouter: true, plugins: { jobSources } });
  return { a: t, token: await t.login() };
}

const sources = async (a: TestApp): Promise<SourceStatus[]> => (await a.api('GET', '/api/sources')).body.sources;
const configured = (a: TestApp): { name: string }[] => (readConfig(a.dbPath, 'plugins') as { jobSources: { name: string }[] }).jobSources;
const version = async (a: TestApp): Promise<string> => ((await a.api('GET', '/api/plugins')).body as PluginsReport).config.version;

describe('duplicate GitHub sources (issue #1264)', () => {
  it('a second GitHub source for the same account and repositories is refused, naming the first; the first stays', async () => {
    const { a, token } = await start([ACCOUNT]);
    const r = await a.ui<{ error: string }>('/ui/api/plugins', { action: 'add', role: 'job-source', plugin: 'github-account', name: 'gh-2', options: { executor: 'test' }, version: await version(a) }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/github-account/);
    expect(configured(a).map((s) => s.name)).toEqual(['github-account']);
  });

  it('turning a second one on is refused the same way', async () => {
    const { a, token } = await start([ACCOUNT, { name: 'gh-2', plugin: 'github-account', options: { executor: 'test', enabled: false } }]);
    const r = await a.ui<{ error: string }>('/ui/api/plugins', { action: 'options', role: 'job-source', name: 'gh-2', options: { executor: 'test', enabled: true }, version: await version(a) }, { token });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/github-account/);
  });

  it('duplicates already configured show, each naming the first; a remove leaves exactly one source', async () => {
    const { a, token } = await start([ACCOUNT, { name: 'gh-2', plugin: 'github-account', options: { executor: 'test', pollSeconds: 3600 } }]);
    await vi.waitFor(async () => expect((await sources(a)).find((s) => s.name === 'gh-2')).toMatchObject({ duplicateOf: 'github-account' }), { timeout: 5000 });
    expect((await sources(a)).find((s) => s.name === 'github-account')?.duplicateOf).toBeUndefined();
    const r = await a.ui('/ui/api/plugins', { action: 'remove', role: 'job-source', name: 'gh-2', version: await version(a) }, { token });
    expect(r.status).toBe(200);
    expect(configured(a).map((s) => s.name)).toEqual(['github-account']);
    await vi.waitFor(async () => expect((await sources(a)).filter((s) => s.kind === 'github-account').map((s) => s.name)).toEqual(['github-account']), { timeout: 5000 });
    expect((await sources(a)).some((s) => s.duplicateOf !== undefined)).toBe(false);
  });

  it('each source shows its poll interval and its calls in the last hour and day', async () => {
    const { a } = await start([ACCOUNT]);
    await vi.waitFor(async () => expect((await sources(a)).find((s) => s.name === 'github-account')).toMatchObject({
      pollMs: 3_600_000, nextPollMs: 3_600_000, calls: { lastHour: 0, lastDay: 0 },
    }), { timeout: 5000 });
  });
});
