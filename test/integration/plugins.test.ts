// Phase 5 slice 1 through the real composition root: the plugin host, plugins.yaml, custom
// plugins from the plugin dir, GET /api/plugins, the router fallback in /api/health, and a store
// written before plugins existed.
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';
import { ALWAYS_PROCEED_DIR } from '../plugins/support.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(o: { before?: (dataDir: string) => void; plugins?: Record<string, unknown>; realRouter?: boolean } = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  o.before?.(dirname(db.dbPath));
  t = await startTestApp({ dbPath: db.dbPath, realRouter: o.realRouter ?? true, ...(o.plugins ? { plugins: o.plugins } : {}) });
  return t;
}

const installAlwaysProceed = (dataDir: string) => cpSync(ALWAYS_PROCEED_DIR, join(dataDir, 'plugins', 'always-proceed'), { recursive: true });
const writePluginsYaml = (dataDir: string, text: string) => writeFileSync(join(dataDir, 'plugins.yaml'), text, { mode: 0o600 });

// The real detection kit runs here: these tests assume no Jev checkout at
// ~/workbench/jev-src/grok-bot-jev (jev-router's default jevSrc); with one, jev-router is chosen.
const JEV_PRESENT = existsSync(join(homedir(), 'workbench/jev-src/grok-bot-jev/src/router.py'));

describe.skipIf(JEV_PRESENT)('router chosen from what is detected, no Jev checkout', () => {
  it('no router in plugins.yaml → pass-through, chosen, not a fallback; /api/health and /api/router say so', async () => {
    const a = await start();
    const health = (await a.api('GET', '/api/health')).body;
    expect(health).toMatchObject({ ok: true, routerMode: 'shadow', router: 'pass-through', fallback: false });
    expect((await a.api('GET', '/api/router')).body).toEqual({ mode: 'shadow', router: 'pass-through', plugin: 'pass-through', fallback: false });

    const job = await a.pull({ op: 'echo' });
    const advised = await waitFor(async () => (await a.job(job.id)).advice, { what: 'advice' });
    expect(advised).toMatchObject({ action: 'proceed_full', source: 'pass-through' });
    const prioritized = (await a.events('types=job.prioritized')).find((e) => e.jobId === job.id)!;
    expect(prioritized.schemaVersion).toBe(2);
    expect(prioritized.data).toMatchObject({ advice: { source: 'pass-through' }, mode: 'shadow' });
  });

  it('GET /api/plugins: roles, the detected instance, and every plugin; a custom router that can run is chosen', async () => {
    const a = await start({ before: installAlwaysProceed });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.roles).toEqual(['router', 'answerer', 'assessor', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier']);
    expect(body.config).toMatchObject({ source: 'file', path: join(a.dataDir, 'plugins.yaml') });
    expect(body.router).toMatchObject({
      instance: { name: 'always-proceed', plugin: 'always-proceed' }, selection: 'detected',
      detection: { status: 'available' }, active: 'always-proceed', fallback: false,
    });
    const ids = body.plugins.map((p: { id: string; builtin: boolean }) => [p.id, p.builtin]).sort();
    expect(ids).toEqual([
      ['always-escalate', true], ['always-proceed', false], ['claude-cli', true], ['claude-cli-assessor', true], ['claude-plan', true], ['github-app', true], ['github-gh', true],
      ['grokbot-routine', true], ['herdr-claude', true], ['jev-router', true], ['local', true], ['pass-through', true], ['test', true],
    ]);
    const jev = body.plugins.find((p: { id: string }) => p.id === 'jev-router');
    expect(jev).toMatchObject({ role: 'router', describe: expect.any(String), detection: { status: 'unavailable' }, options: { type: 'object', properties: { jevSrc: {}, python: {} } } });
    expect(body.errors).toEqual([]);
  });

  it('a router named in plugins.yaml that cannot run → pass-through as fallback', async () => {
    const a = await start({ before: (d) => writePluginsYaml(d, 'version: 1\nrouter: { name: jev, plugin: jev-router, options: { jevSrc: /nonexistent/grok-bot-jev } }\n') });
    expect((await a.api('GET', '/api/router')).body).toEqual({
      mode: 'shadow', router: 'jev', plugin: 'pass-through', fallback: true, reason: expect.stringContaining('/nonexistent/grok-bot-jev/src/router.py'),
    });
    const job = await a.pull({ op: 'echo' });
    expect(await waitFor(async () => (await a.job(job.id)).advice, { what: 'advice' })).toMatchObject({ source: 'fallback', reason: expect.stringMatching(/^router jev unavailable: /) });
  });
});

describe('plugins.yaml and a custom plugin', () => {
  it('a custom router selected in plugins.yaml advises real jobs', async () => {
    const a = await start({
      before: (d) => { installAlwaysProceed(d); writePluginsYaml(d, 'version: 1\nrouter: { name: mine, plugin: always-proceed, options: { note: from-yaml } }\n'); },
    });
    expect((await a.api('GET', '/api/health')).body).toMatchObject({ router: 'mine', fallback: false });
    expect((await a.api('GET', '/api/plugins')).body.config).toMatchObject({ source: 'file' });
    const job = await a.pull({ op: 'echo' });
    const advised = await waitFor(async () => (await a.job(job.id)).advice, { what: 'advice' });
    expect(advised).toMatchObject({ action: 'proceed_full', reason: 'from-yaml', source: 'always-proceed' });
  });

  it('editing plugins.yaml swaps the router while the daemon runs', async () => {
    const a = await start({
      before: (d) => { installAlwaysProceed(d); writePluginsYaml(d, 'version: 1\nrouter: { name: open, plugin: pass-through }\n'); },
    });
    const first = await a.pull({ op: 'echo' });
    expect(await waitFor(async () => (await a.job(first.id)).advice, { what: 'advice' })).toMatchObject({ source: 'pass-through' });

    writePluginsYaml(a.dataDir, 'version: 1\nrouter: { name: mine, plugin: always-proceed, options: { note: swapped } }\n');
    await waitFor(async () => (await a.api('GET', '/api/router')).body.router === 'mine', { what: 'the swapped router' });
    const second = await a.pull({ op: 'echo' });
    expect(await waitFor(async () => (await a.job(second.id)).advice, { what: 'advice' })).toMatchObject({ source: 'always-proceed', reason: 'swapped' });
  });

  it('an invalid plugins.yaml at start: the detected router, error shown', async () => {
    const a = await start({ before: (d) => writePluginsYaml(d, 'version: 1\nrouter: { plugin: x }\n') });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.config.error).toMatch(/router\.name/);
    expect(body.router).toMatchObject({ selection: 'detected', fallback: false });
  });
});

describe('a store written before plugins', () => {
  it('migrates and runs: router mode kept, advice renamed, old decisions readable, old events still conform', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    mkdirSync(dirname(db.dbPath), { recursive: true });
    copyFileSync(join(import.meta.dirname, '..', 'store', 'fixtures', 'pre-plugins.sqlite'), db.dbPath);
    t = await startTestApp({ dbPath: db.dbPath });
    expect((await t.api('GET', '/api/router')).body.mode).toBe('active');
    const held = await t.job('00000000-0000-4000-8000-000000000002');
    expect(held.advice).toMatchObject({ action: 'ask_human', details: { jevUsed: true } });
    expect(held).not.toHaveProperty('jevAdvice');
    const old = (await t.api('GET', '/api/decisions/decision-1')).body;
    expect(old).toMatchObject({ routerMode: 'active', advice: [{ withAdvice: 'hold' }, { withAdvice: 'start' }] });
    // The held job stays held by the router (active mode) under the new reason.
    await waitFor(async () => (await t!.job(held.id)).holdReason === 'router ask_human: awaiting approval', { what: 'the renamed hold reason' });
    const jobs = (await t.api<{ jobs: Job[] }>('GET', '/api/jobs?limit=100')).body.jobs;
    expect(jobs.filter((j) => j.advice)).toHaveLength(4); // the unclassified one is advised by the fake on startup
  });
});

describe('question roles in /api/plugins (slice 2)', () => {
  it('no section: the built-in instances, answerer opus (claude-cli), assessor fable (claude-cli-assessor)', async () => {
    const a = await start();
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.answerer.instance).toEqual({ name: 'opus', plugin: 'claude-cli', options: { bin: 'claude', model: 'opus', timeoutMs: 180000 } });
    expect(body.assessor.instance).toEqual({ name: 'fable', plugin: 'claude-cli-assessor', options: { bin: 'claude', model: 'fable', timeoutMs: 180000 } });
  });

  it('sections with a bin and models: those instances, detected', async () => {
    const a = await start({ plugins: {
      answerer: { name: 'opus', plugin: 'claude-cli', options: { bin: process.execPath, model: 'sonnet', timeoutMs: 1234 } },
      assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { bin: process.execPath, model: 'haiku', timeoutMs: 1234 } },
    } });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.answerer).toEqual({
      instance: { name: 'opus', plugin: 'claude-cli', options: { bin: process.execPath, model: 'sonnet', timeoutMs: 1234 } },
      detection: { status: 'available', detail: expect.any(String) }, active: 'claude-cli', fallback: false,
    });
    expect(body.assessor).toEqual({
      instance: { name: 'fable', plugin: 'claude-cli-assessor', options: { bin: process.execPath, model: 'haiku', timeoutMs: 1234 } },
      detection: { status: 'available', detail: expect.any(String) }, active: 'claude-cli-assessor', fallback: false,
    });
  });

  it('claude not installed: no answerer, and the assessor falls back to always-escalate — shown', async () => {
    const a = await start({ plugins: {
      answerer: { name: 'opus', plugin: 'claude-cli', options: { bin: '/nonexistent/claude' } },
      assessor: { name: 'fable', plugin: 'claude-cli-assessor', options: { bin: '/nonexistent/claude' } },
    } });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.answerer).toMatchObject({ instance: { name: 'opus' }, detection: { status: 'unavailable' }, active: null, fallback: true, reason: expect.stringContaining('/nonexistent/claude') });
    expect(body.assessor).toMatchObject({ instance: { name: 'fable' }, detection: { status: 'unavailable' }, active: 'always-escalate', fallback: true });
  });

  it('answerer: null and another assessor', async () => {
    const a = await start({ before: (d) => writePluginsYaml(d, 'version: 1\nanswerer: null\nassessor: { name: wall, plugin: always-escalate }\n') });
    const body = (await a.api('GET', '/api/plugins')).body;
    expect(body.answerer).toEqual({ instance: null, active: null, fallback: false });
    expect(body.assessor).toMatchObject({ instance: { name: 'wall', plugin: 'always-escalate' }, active: 'always-escalate', fallback: false });
  });
});

describe('a store written before the assessor', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('open questions at opus and at fable both restart at the answer stage; the human one stays with the human', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    mkdirSync(dirname(db.dbPath), { recursive: true });
    copyFileSync(join(import.meta.dirname, '..', 'store', 'fixtures', 'pre-assessor.sqlite'), db.dbPath);
    t = await startTestApp({ dbPath: db.dbPath });
    for (const jobId of [id(1), id(5)]) {
      expect((await t.waitForStatus(jobId, 'finished')).result).toEqual({ answer: 'fake opus answer' });
      const [q] = await t.questionsOf(jobId);
      expect(q).toMatchObject({ status: 'answered', answeredBy: 'opus' });
      expect(q!.attempts.slice(-2).map((a) => [a.tier, a.role, a.outcome])).toEqual([['opus', 'answerer', 'drafted'], ['fable', 'assessor', 'accepted']]);
    }
    const restarted = (await t.events()).filter((e) => e.type === 'question.escalated' && e.schemaVersion === 2 && e.questionId === id(6));
    expect(restarted.map((e) => e.data.target)).toEqual(['opus', 'fable']);
    expect(await t.job(id(10))).toMatchObject({ status: 'waiting_answer' });
    expect((await t.api('GET', `/api/questions/${id(11)}`)).body).toMatchObject({ status: 'open', tier: 'human', notifyCount: expect.any(Number) });
    expect((await t.api('GET', `/api/questions/${id(16)}`)).body).toMatchObject({ status: 'answered', answeredBy: 'fable' });
    // stop() validates every stored event, the v1 question events included.
  });
});
