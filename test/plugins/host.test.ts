// The plugin host: built-in + custom plugins, plugins.yaml (router, answerer, assessor sections)
// with an mtime watch, detection, the live router with its fallback to pass-through, and the live
// question roles: no answerer when it cannot run, always-escalate when the assessor cannot.
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { Job, Question } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import jevRouter from '../../src/plugins/router/jev-router/index.ts';
import passThrough from '../../src/plugins/router/pass-through/index.ts';
import { createPluginHost, type PluginHost, type PluginHostOptions } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { waitFor } from '../support/wait.ts';
import { ALWAYS_PROCEED_DIR, fakeKit, fixedClock, useTempDirs, writePlugin } from './support.ts';

const temp = useTempDirs();
const job = { id: 'j1', spec: { executor: 'test', payload: {} } } as Job;
let host: PluginHost | undefined;
afterEach(() => { host?.stop(); host = undefined; });

/** A router that tags its advice with its instance options, so a swap is visible. */
const tagging: PluginDefinition<'router'> = {
  id: 'tagging', role: 'router', describe: 'tags advice',
  options: (z) => z.object({ tag: z.string(), gate: z.boolean().default(false) }),
  async detect() { return { status: 'available' }; },
  create(ctx, o: { tag: string }) {
    return { name: 'tagging', async advise() { return { action: 'chat_only', reason: o.tag, details: {}, source: 'tagging', at: ctx.clock.now().toISOString() }; } };
  },
};
const brokenCreate: PluginDefinition<'router'> = {
  ...tagging, id: 'broken-create', options: undefined, create() { throw new Error('cannot start'); },
};
const throwingAdvise: PluginDefinition<'router'> = {
  ...tagging, id: 'throwing', options: undefined,
  create() { return { name: 'throwing', async advise() { throw new Error('advise blew up'); } }; },
};
/** Question-role plugins that answer from their options, so a swap is visible. */
const cannedAnswerer: PluginDefinition<'answerer'> = {
  id: 'canned-answerer', role: 'answerer', describe: 'answers from options',
  options: (z) => z.object({ answer: z.string().default('canned') }),
  async detect() { return { status: 'available' }; },
  create(_ctx, o: { answer: string }) {
    return { name: 'canned-answerer', async answer() { return { answer: o.answer, confident: true, reason: 'canned' }; } };
  },
};
const cannedAssessor: PluginDefinition<'assessor'> = {
  id: 'canned-assessor', role: 'assessor', describe: 'never escalates',
  async detect() { return { status: 'available' }; },
  create() { return { name: 'canned-assessor', async assess() { return { escalate: false, reason: 'canned' }; } }; },
};
const request = {
  question: { id: 'q', jobId: 'j', text: 't', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'opus', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '' } as Question,
  jobPrompt: '', rules: '', previous: [],
} satisfies AnswerRequest;
const draft = { answer: 'a', confident: true, reason: 'r' };
let selfFallback = true;
const selfFallingBack: PluginDefinition<'router'> = {
  ...tagging, id: 'self-fallback', options: undefined,
  create(ctx) {
    return { name: 'self-fallback', async advise() {
      return { action: 'proceed_full', reason: selfFallback ? 'jev unavailable: x' : 'ok', details: {}, source: selfFallback ? 'fallback' : 'self-fallback', at: ctx.clock.now().toISOString() };
    } };
  },
};

function start(o: {
  file?: string; kit?: DetectionKit; pluginDir?: string; builtins?: readonly PluginDefinition[];
  defaultAnswerer?: PluginHostOptions['defaultAnswerer']; defaultAssessor?: PluginHostOptions['defaultAssessor'];
} = {}) {
  const dir = temp();
  const pluginsFile = join(dir, 'plugins.yaml');
  if (o.file !== undefined) writeFileSync(pluginsFile, o.file, { mode: 0o600 });
  host = createPluginHost({
    pluginDir: o.pluginDir ?? join(dir, 'plugins'), pluginsFile, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit(),
    builtins: o.builtins ?? [...BUILTIN_PLUGINS, tagging, brokenCreate, throwingAdvise, selfFallingBack, cannedAnswerer, cannedAssessor],
    defaultAnswerer: o.defaultAnswerer === undefined ? { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } } : o.defaultAnswerer,
    defaultAssessor: o.defaultAssessor ?? { name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'fable' } },
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    intervalMs: 30,
  });
  return { host, pluginsFile };
}

describe('router chosen from what is detected (no router in plugins.yaml)', () => {
  it('jev-router detected → the router is jev-router, not a fallback', async () => {
    const { host } = start({ builtins: [...BUILTIN_PLUGINS] });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'jev-router', plugin: 'jev-router', fallback: false });
    expect(host.report().router).toMatchObject({ instance: { name: 'jev-router', plugin: 'jev-router' }, selection: 'detected', fallback: false });
  });

  it('no router but pass-through can run → pass-through, chosen, not a fallback', async () => {
    const { host } = start({ builtins: [...BUILTIN_PLUGINS], kit: fakeKit({ exists: async () => false }) });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'pass-through', plugin: 'pass-through', fallback: false });
    expect(await host.router.advise(job)).toMatchObject({ action: 'proceed_full', source: 'pass-through' });
    expect(host.report().router).toMatchObject({ instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' } });
  });

  it('a custom router that can run is chosen when jev-router cannot', async () => {
    const pluginDir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(pluginDir, 'always-proceed'), { recursive: true });
    const { host } = start({ pluginDir, builtins: [...BUILTIN_PLUGINS], kit: fakeKit({ exists: async () => false }) });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'always-proceed', plugin: 'always-proceed', fallback: false });
  });

  it('built-ins come first, in their order; a router that detects but cannot start is skipped', async () => {
    const { host } = start({ builtins: [passThrough, brokenCreate, jevRouter, tagging] });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'jev-router', plugin: 'jev-router', fallback: false });
  });

  it('a router named in plugins.yaml wins over detection; selection says file', async () => {
    const { host } = start({ file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: t } }\n' });
    await host.start();
    expect(host.report().router).toMatchObject({ instance: { name: 'one' }, selection: 'file' });
  });
});

describe('fallback to pass-through', () => {
  it.each([
    ['create throws', 'router: { name: b, plugin: broken-create }', /cannot start/],
    ['unknown plugin', 'router: { name: u, plugin: no-such-plugin }', /unknown router plugin no-such-plugin/],
    ['invalid options', 'router: { name: t, plugin: tagging, options: { tag: 3 } }', /options.*tag/],
  ])('%s', async (_name, section, why) => {
    const { host } = start({ file: `version: 1\n${section}\n` });
    await host.start();
    expect(host.routerStatus()).toMatchObject({ plugin: 'pass-through', fallback: true, reason: expect.stringMatching(why) });
    expect(await host.router.advise(job)).toMatchObject({ action: 'proceed_full', source: 'fallback' });
  });

  it('a router whose advise throws gives fallback advice, never a rejection', async () => {
    const { host } = start({ file: 'version: 1\nrouter: { name: x, plugin: throwing }\n' });
    await host.start();
    const advice = await host.router.advise(job);
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', reason: expect.stringContaining('advise blew up') });
    expect(host.routerStatus().fallback).toBe(true);
  });

  it('advice the router itself marks fallback shows as fallback until it recovers', async () => {
    selfFallback = true;
    const { host } = start({ file: 'version: 1\nrouter: { name: s, plugin: self-fallback }\n' });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 's', plugin: 'self-fallback', fallback: false });
    await host.router.advise(job);
    expect(host.routerStatus()).toEqual({ name: 's', plugin: 'self-fallback', fallback: true, reason: 'jev unavailable: x' });
    selfFallback = false;
    await host.router.advise(job);
    expect(host.routerStatus().fallback).toBe(false);
  });
});

describe('plugins.yaml live reload (router swaps between calls)', () => {
  it('a changed router section swaps the router; a broken edit keeps the last good one; removal returns to the detected one', async () => {
    const { host, pluginsFile } = start({
      file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: first } }\n',
      builtins: [passThrough, tagging],
    });
    await host.start();
    expect(host.report().config).toMatchObject({ source: 'file', path: pluginsFile });
    expect((await host.router.advise(job)).reason).toBe('first');

    writeFileSync(pluginsFile, 'version: 1\nrouter: { name: two, plugin: tagging, options: { tag: second-one } }\n');
    await waitFor(async () => (await host.router.advise(job)).reason === 'second-one', { what: 'the swapped router' });
    expect(host.routerStatus()).toEqual({ name: 'two', plugin: 'tagging', fallback: false });

    writeFileSync(pluginsFile, 'version: 1\nrouter: [broken\n');
    await waitFor(() => host.report().config.error, { what: 'the config error' });
    expect((await host.router.advise(job)).reason).toBe('second-one');

    rmSync(pluginsFile);
    await waitFor(() => host.routerStatus().name === 'pass-through', { what: 'the detected router' });
    expect(host.report().router).toMatchObject({ selection: 'detected' });
    expect(host.report().config.error).toBeUndefined();
    expect(await host.router.advise(job)).toMatchObject({ source: 'pass-through' });
  });

  it('reload() re-reads now', async () => {
    const { host, pluginsFile } = start({ file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: a } }\n' });
    await host.start();
    host.stop();
    writeFileSync(pluginsFile, 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: bb } }\n');
    await host.reload();
    expect((await host.router.advise(job)).reason).toBe('bb');
  });
});

describe('custom plugins through the host', () => {
  it('a custom router named in plugins.yaml advises', async () => {
    const pluginDir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(pluginDir, 'always-proceed'), { recursive: true });
    const { host } = start({ pluginDir, file: 'version: 1\nrouter: { name: mine, plugin: always-proceed, options: { note: custom } }\n' });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'mine', plugin: 'always-proceed', fallback: false });
    expect(await host.router.advise(job)).toMatchObject({ reason: 'custom', source: 'always-proceed' });
  });

  it('report: roles, every router plugin with builtin flag, detection and options schema, and load errors', async () => {
    const pluginDir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(pluginDir, 'always-proceed'), { recursive: true });
    writePlugin(pluginDir, 'clash', "export default { id: 'pass-through', role: 'router', describe: 'x', async detect() { return { status: 'available' }; }, create() {} };\n", 'index.js');
    const { host } = start({ pluginDir, kit: fakeKit({ exists: async () => false }) });
    await host.start();
    const r = host.report();
    expect(r.roles).toEqual(['router', 'queue-sorter', 'answerer', 'assessor', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier']);
    const byId = new Map(r.plugins.map((p) => [p.id, p]));
    expect(byId.get('jev-router')).toMatchObject({
      role: 'router', builtin: true, detection: { status: 'unavailable' },
      options: { type: 'object', properties: { jevSrc: { type: 'string' }, python: { type: 'string' } } },
    });
    expect(byId.get('pass-through')).toMatchObject({ builtin: true, detection: { status: 'available' } });
    expect(byId.get('always-proceed')).toMatchObject({
      builtin: false, path: join(pluginDir, 'always-proceed', 'index.ts'), describe: 'Admits every job as proceed_full',
      detection: { status: 'available' }, options: { properties: { note: { type: 'string' } } },
    });
    expect(r.errors).toEqual([{ path: join(pluginDir, 'clash', 'index.js'), error: expect.stringMatching(/built-in/) }]);
  });

  it('a plugin whose detect throws is reported unavailable', async () => {
    const pluginDir = temp();
    writePlugin(pluginDir, 'det', "export default { id: 'det', role: 'router', describe: 'x', async detect() { throw new Error('probe failed'); }, create() {} };\n", 'index.js');
    const { host } = start({ pluginDir });
    await host.start();
    expect(host.report().plugins.find((p) => p.id === 'det')!.detection).toEqual({ status: 'unavailable', reason: expect.stringContaining('probe failed') });
  });
});

describe('question roles (answerer 0..1, assessor 1)', () => {
  it('from the environment: answerer opus (claude-cli), assessor fable (claude-cli-assessor), both detected', async () => {
    const { host } = start();
    await host.start();
    expect(host.answerer()).toMatchObject({ name: 'opus' });
    expect(host.assessor()).toMatchObject({ name: 'fable' });
    const r = host.report();
    expect(r.answerer).toEqual({
      instance: { name: 'opus', plugin: 'claude-cli', options: { model: 'opus' } },
      detection: { status: 'available', detail: '1.0.0' }, active: 'claude-cli', fallback: false,
    });
    expect(r.assessor).toEqual({
      instance: { name: 'fable', plugin: 'claude-cli-assessor', options: { model: 'fable' } },
      detection: { status: 'available', detail: '1.0.0' }, active: 'claude-cli-assessor', fallback: false,
    });
    const byId = new Map(r.plugins.map((p) => [p.id, p]));
    expect(byId.get('claude-cli')).toMatchObject({ role: 'answerer', builtin: true, options: { properties: { bin: {}, model: {}, timeoutMs: {}, effort: {} } } });
    expect(byId.get('claude-cli-assessor')).toMatchObject({ role: 'assessor', builtin: true, options: { properties: { bin: {}, model: {}, timeoutMs: {} } } });
    expect(byId.get('always-escalate')).toMatchObject({ role: 'assessor', builtin: true, detection: { status: 'available' } });
  });

  it('claude missing: no answerer; the assessor falls back to always-escalate, shown in the report', async () => {
    const { host } = start({ kit: fakeKit({ which: async () => undefined }) });
    await host.start();
    expect(host.answerer()).toBeUndefined();
    expect(host.report().answerer).toMatchObject({
      instance: { name: 'opus', plugin: 'claude-cli' }, detection: { status: 'unavailable' }, active: null, fallback: true,
      reason: expect.stringContaining('claude'),
    });
    expect(host.assessor().name).toBe('fable');
    expect(host.report().assessor).toMatchObject({
      instance: { name: 'fable', plugin: 'claude-cli-assessor' }, active: 'always-escalate', fallback: true, reason: expect.stringContaining('claude'),
    });
    expect(await host.assessor().assess(request, draft, new AbortController().signal)).toEqual({
      escalate: true, reason: expect.stringMatching(/^assessor fable unavailable: /),
    });
  });

  it.each([
    ['an unknown plugin', 'assessor: { name: x, plugin: no-such }', /unknown assessor plugin no-such/],
    ['a plugin of another role', 'assessor: { name: x, plugin: canned-answerer }', /unknown assessor plugin canned-answerer/],
  ])('assessor with %s → always-escalate', async (_n, section, why) => {
    const { host } = start({ file: `version: 1\n${section}\n` });
    await host.start();
    expect(host.report().assessor).toMatchObject({ active: 'always-escalate', fallback: true, reason: expect.stringMatching(why) });
  });

  it('answerer: null in plugins.yaml → no answerer, not a fallback', async () => {
    const { host } = start({ file: 'version: 1\nanswerer: null\n' });
    await host.start();
    expect(host.answerer()).toBeUndefined();
    expect(host.report().answerer).toEqual({ instance: null, active: null, fallback: false });
  });

  it('plugins.yaml swaps answerer and assessor between calls', async () => {
    const { host, pluginsFile } = start();
    await host.start();
    expect(host.answerer()!.name).toBe('opus');
    writeFileSync(pluginsFile, 'version: 1\nanswerer: { name: quick, plugin: canned-answerer, options: { answer: yes } }\nassessor: { name: lenient, plugin: canned-assessor }\n');
    await waitFor(() => host.answerer()?.name === 'quick', { what: 'the swapped answerer' });
    expect(await host.answerer()!.answer(request, new AbortController().signal)).toEqual({ answer: 'yes', confident: true, reason: 'canned' });
    expect(host.assessor().name).toBe('lenient');
    expect(await host.assessor().assess(request, draft, new AbortController().signal)).toEqual({ escalate: false, reason: 'canned' });
    expect(host.report().answerer).toMatchObject({ instance: { name: 'quick' }, active: 'canned-answerer' });
  });

  it('an answerer and an assessor resolving to one name is a config error; the last good instances stay', async () => {
    const { host } = start({ file: 'version: 1\nanswerer: { name: fable, plugin: canned-answerer }\n' });
    await host.start();
    expect(host.report().config.error).toMatch(/same name/);
    expect(host.answerer()!.name).toBe('opus');
    expect(host.assessor().name).toBe('fable');
  });
});
