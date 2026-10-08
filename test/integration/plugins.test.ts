// Phase 5 slice 1 through the real composition root: the plugin host, the plugins config, custom
// plugins from the plugin dir, GET /api/plugins, the router fallback in /api/health, and a store
// written before plugins existed.
import { cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, writePlugins, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { ALWAYS_PROCEED_DIR } from '../plugins/support.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(o: { before?: (dbPath: string) => void; plugins?: Record<string, unknown>; realRouter?: boolean } = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  o.before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath, realRouter: o.realRouter ?? true, ...(o.plugins ? { plugins: o.plugins } : {}) });
  return t;
}

const installAlwaysProceed = (dbPath: string) => cpSync(ALWAYS_PROCEED_DIR, join(dirname(dbPath), 'plugins', 'always-proceed'), { recursive: true });

// jevPath has no default: without it gate-router needs setup and is never chosen, whatever is on this machine.
describe('router chosen from what is detected, no grok-bot-jev checkout', () => {
  it('no router in the plugins config → pass-through, chosen, not a fallback; /api/health and /api/router say so', async () => {
    const a = await start();
    const health = (await a.api('GET', '/api/health')).body;
    expect(health).toMatchObject({ ok: true, router: 'pass-through', fallback: false });
    expect((await a.api('GET', '/api/router')).body).toEqual({ router: 'pass-through', plugin: 'pass-through', fallback: false });

    const job = await a.pull({ op: 'echo' });
    const advised = await waitFor(async () => (await a.job(job.id)).advice, { what: 'advice' });
    expect(advised).toMatchObject({ action: 'proceed_full', source: 'pass-through' });
    const prioritized = (await a.events('types=job.prioritized')).find((e) => e.jobId === job.id)!;
    expect(prioritized.schemaVersion).toBe(3);
    expect(prioritized.data).toEqual({ advice: expect.objectContaining({ source: 'pass-through' }), statusAtAdvice: expect.any(String) });
  });

  it('GET /api/plugins: roles, the detected instance, and every plugin; a custom router that can run is chosen', async () => {
    const a = await start({ before: installAlwaysProceed });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.roles).toEqual(['router', 'queue-sorter', 'escalation-level', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier']);
    expect(body.config).toMatchObject({ source: 'stored' });
    expect(body.config).not.toHaveProperty('document');
    expect(body.router).toMatchObject({
      instance: { name: 'always-proceed', plugin: 'always-proceed' }, selection: 'detected',
      detection: { status: 'available' }, active: 'always-proceed', fallback: false,
    });
    const ids = body.plugins.map((p: { id: string; builtin: boolean }) => [p.id, p.builtin]).sort();
    expect(ids).toEqual([
      ['always-proceed', false], ['anthropic-api', true], ['claude-cli', true], ['claude-plan', true], ['client', true], ['codex', true], ['command', true], ['command-usage', true], ['cursor-agent', true], ['docker', true], ['gate-router', true], ['github-account', true], ['github-app', true],
      ['grokbot-routine', true], ['herdr-claude', true], ['local', true], ['newest-first', true], ['oldest-first', true], ['omp', true], ['opencode', true], ['pass-through', true], ['priority', true], ['ssh', true],
      ['test', true],
    ]);
    const gates = body.plugins.find((p: { id: string }) => p.id === 'gate-router');
    expect(gates).toMatchObject({ role: 'router', describe: expect.any(String), detection: { status: 'needs-setup' }, options: { type: 'object', properties: { jevPath: {}, python: {} } } });
    expect(body.errors).toEqual([]);
  });

  it('a router named in the plugins config that cannot run → pass-through as fallback', async () => {
    const a = await start({ before: (d) => writePlugins(d, { version: 1, router: { name: 'gate-router', plugin: 'gate-router', options: { jevPath: '/nonexistent/grok-bot-jev' } } }) });
    expect((await a.api('GET', '/api/router')).body).toEqual({
      router: 'gate-router', plugin: 'pass-through', fallback: true, reason: expect.stringContaining('/nonexistent/grok-bot-jev/src/router.py'),
    });
    const job = await a.pull({ op: 'echo' });
    expect(await waitFor(async () => (await a.job(job.id)).advice, { what: 'advice' })).toMatchObject({ source: 'fallback', reason: expect.stringMatching(/^router gate-router unavailable: /) });
  });
});

describe('the plugins config and a custom plugin', () => {
  it('a custom router selected in the plugins config advises real jobs', async () => {
    const a = await start({
      before: (d) => { installAlwaysProceed(d); writePlugins(d, { version: 1, router: { name: 'mine', plugin: 'always-proceed', options: { note: 'from-config' } } }); },
    });
    expect((await a.api('GET', '/api/health')).body).toMatchObject({ router: 'mine', fallback: false });
    expect((await a.api('GET', '/api/plugins')).body.config).toMatchObject({ source: 'stored' });
    const job = await a.pull({ op: 'echo' });
    const advised = await waitFor(async () => (await a.job(job.id)).advice, { what: 'advice' });
    expect(advised).toMatchObject({ action: 'proceed_full', reason: 'from-config', source: 'always-proceed' });
  });

  it('changing the plugins config swaps the router while the daemon runs', async () => {
    const a = await start({
      before: (d) => { installAlwaysProceed(d); writePlugins(d, { version: 1, router: { name: 'open', plugin: 'pass-through' } }); },
    });
    const first = await a.pull({ op: 'echo' });
    expect(await waitFor(async () => (await a.job(first.id)).advice, { what: 'advice' })).toMatchObject({ source: 'pass-through' });

    writePlugins(a.dbPath, { version: 1, router: { name: 'mine', plugin: 'always-proceed', options: { note: 'swapped' } } });
    await waitFor(async () => (await a.api('GET', '/api/router')).body.router === 'mine', { what: 'the swapped router' });
    const second = await a.pull({ op: 'echo' });
    expect(await waitFor(async () => (await a.job(second.id)).advice, { what: 'advice' })).toMatchObject({ source: 'always-proceed', reason: 'swapped' });
  });

  it('an invalid plugins config at start: the detected router, error shown', async () => {
    const a = await start({ before: (d) => writePlugins(d, { version: 1, router: { plugin: 'x' } }) });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.config.error).toMatch(/router\.name/);
    expect(body.router).toMatchObject({ selection: 'detected', fallback: false });
  });
});

describe('escalation levels in /api/plugins', () => {
  it('no section: the built-in levels, level-1 then level-2, both claude-cli', async () => {
    const a = await start();
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.escalationLevels.map((l: { instance: unknown }) => l.instance)).toEqual([
      { name: 'level-1', plugin: 'claude-cli', options: { machine: 'local', bin: 'claude', model: 'opus', timeoutMs: 180000 } },
      { name: 'level-2', plugin: 'claude-cli', options: { machine: 'local', bin: 'claude', model: 'fable', timeoutMs: 180000 } },
    ]);
  });

  it('a section with a bin and models: those levels, in order, detected', async () => {
    const a = await start({ plugins: { escalationLevels: [
      { name: 'quick', plugin: 'claude-cli', options: { machine: 'local', bin: process.execPath, model: 'haiku', timeoutMs: 1234 } },
      { name: 'deep', plugin: 'claude-cli', options: { machine: 'local', bin: process.execPath, model: 'fable', timeoutMs: 1234 } },
    ] } });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.escalationLevels).toEqual([
      { instance: { name: 'quick', plugin: 'claude-cli', options: { machine: 'local', bin: process.execPath, model: 'haiku', timeoutMs: 1234 } }, detection: { status: 'available', detail: expect.any(String) }, active: 'claude-cli' },
      { instance: { name: 'deep', plugin: 'claude-cli', options: { machine: 'local', bin: process.execPath, model: 'fable', timeoutMs: 1234 } }, detection: { status: 'available', detail: expect.any(String) }, active: 'claude-cli' },
    ]);
  });

  it('a level that names no machine runs, and says which machine it uses: the only one there is (#442)', async () => {
    const a = await start({ plugins: { escalationLevels: [{ name: 'level-1', plugin: 'claude-cli', options: { bin: 'claude' } }] } });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.escalationLevels).toEqual([expect.objectContaining({
      instance: expect.objectContaining({ name: 'level-1' }), detection: expect.objectContaining({ status: 'available' }), active: 'claude-cli',
      machine: { machine: 'local', needsMachine: false, note: 'names no machine: runs on local, the only machine that can run claude' },
    })]);
  });

  it('escalationLevels: [] — no levels', async () => {
    const a = await start({ before: (d) => writePlugins(d, { version: 1, escalationLevels: [] }) });
    expect((await a.api('GET', '/api/plugins')).body.escalationLevels).toEqual([]);
  });
});

