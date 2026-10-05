// The plugin host: built-in + custom plugins, plugins.yaml (router, escalationLevels sections) with
// a version watch, detection, the live router with its fallback to pass-through, and the live
// escalation levels: a level that cannot run stays in its place and escalates every question.
import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AnswerRequest } from '../../src/domain/ports.ts';
import type { Job, Question } from '../../src/domain/types.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import passThrough from '../../src/plugins/router/pass-through/index.ts';
import { createPluginHost, type PluginHost, type PluginHostOptions } from '../../src/plugins/index.ts';
import type { DetectionKit, PluginDefinition } from '../../src/plugins/sdk.ts';
import { waitFor } from '../support/wait.ts';
import { PLUGINS } from '../../src/plugins/plugins-file.ts';
import { useTempDocuments } from '../support/documents.ts';
import { ALWAYS_PROCEED_DIR, fakeKit, fixedClock, useTempDirs, writePlugin } from './support.ts';

const temp = useTempDirs();
const docs = useTempDocuments();
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
/** An escalation level that answers from its options, so a swap is visible. */
const cannedLevel: PluginDefinition<'escalation-level'> = {
  id: 'canned-level', role: 'escalation-level', describe: 'answers from options',
  options: (z) => z.object({ answer: z.string().default('canned') }),
  async detect() { return { status: 'available' }; },
  create(_ctx, o: { answer: string }) {
    return { name: 'canned-level', async answer() { return { answer: o.answer, escalate: false, reason: 'canned' }; } };
  },
};
const request = {
  question: { id: 'q', jobId: 'j', text: 't', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'opus', attempts: [], notifyCount: 0, createdAt: '', updatedAt: '' } as Question,
  jobPrompt: '', rules: '', previous: [], level: { number: 1, of: 2 },
} satisfies AnswerRequest;
const DEFAULT_LEVELS = [
  { name: 'opus', plugin: 'claude-cli', options: { model: 'opus', machine: 'local' } },
  { name: 'fable', plugin: 'claude-cli', options: { model: 'fable', machine: 'local' } },
];
let selfFallback = true;
const selfFallingBack: PluginDefinition<'router'> = {
  ...tagging, id: 'self-fallback', options: undefined,
  create(ctx) {
    return { name: 'self-fallback', async advise() {
      return { action: 'proceed_full', reason: selfFallback ? 'router unavailable: x' : 'ok', details: {}, source: selfFallback ? 'fallback' : 'self-fallback', at: ctx.clock.now().toISOString() };
    } };
  },
};

function start(o: {
  file?: string; kit?: DetectionKit; pluginDir?: string; builtins?: readonly PluginDefinition[];
  defaultLevels?: PluginHostOptions['defaultLevels'];
} = {}) {
  const dir = temp();
  const documents = docs();
  if (o.file !== undefined) documents.set(PLUGINS, o.file);
  host = createPluginHost({
    pluginDir: o.pluginDir ?? join(dir, 'plugins'), documents, dataDir: dir, clock: fixedClock,
    logger: { info() {}, warn() {} }, routerMode: () => 'shadow', kit: o.kit ?? fakeKit(),
    builtins: o.builtins ?? [...BUILTIN_PLUGINS, tagging, brokenCreate, throwingAdvise, selfFallingBack, cannedLevel],
    defaultLevels: o.defaultLevels ?? DEFAULT_LEVELS,
    defaultExecutors: [{ name: 'test', plugin: 'test' }],
    intervalMs: 30,
  });
  return { host, documents };
}

describe('router chosen from what is detected (no router in plugins.yaml)', () => {
  it('gate-router has no default grok-bot-jev checkout, so detection never picks it: pass-through, not a fallback', async () => {
    const { host } = start({ builtins: [...BUILTIN_PLUGINS] });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'pass-through', plugin: 'pass-through', fallback: false });
    expect(host.report().router).toMatchObject({ instance: { name: 'pass-through' }, selection: 'detected', fallback: false });
  });

  it('gate-router named in plugins.yaml with its grokBotJevSrc is the router, not a fallback', async () => {
    const { host } = start({ builtins: [...BUILTIN_PLUGINS], file: 'version: 1\nrouter: { name: gate-router, plugin: gate-router, options: { grokBotJevSrc: /j/grok-bot-jev } }\n' });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'gate-router', plugin: 'gate-router', fallback: false });
    expect(host.report().router).toMatchObject({ instance: { name: 'gate-router', plugin: 'gate-router' }, selection: 'file', fallback: false });
  });

  it('no router but pass-through can run → pass-through, chosen, not a fallback', async () => {
    const { host } = start({ builtins: [...BUILTIN_PLUGINS], kit: fakeKit({ exists: async () => false }) });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'pass-through', plugin: 'pass-through', fallback: false });
    expect(await host.router.advise(job)).toMatchObject({ action: 'proceed_full', source: 'pass-through' });
    expect(host.report().router).toMatchObject({ instance: { name: 'pass-through', plugin: 'pass-through' }, selection: 'detected', detection: { status: 'available' } });
  });

  it('a custom router that can run is chosen when gate-router cannot', async () => {
    const pluginDir = temp();
    cpSync(ALWAYS_PROCEED_DIR, join(pluginDir, 'always-proceed'), { recursive: true });
    const { host } = start({ pluginDir, builtins: [...BUILTIN_PLUGINS], kit: fakeKit({ exists: async () => false }) });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'always-proceed', plugin: 'always-proceed', fallback: false });
  });

  it('built-ins come first, in their order; a router that detects but cannot start is skipped', async () => {
    const second: PluginDefinition<'router'> = { ...tagging, id: 'second', options: undefined };
    const { host } = start({ builtins: [brokenCreate, second, passThrough, tagging] });
    await host.start();
    expect(host.routerStatus()).toEqual({ name: 'second', plugin: 'second', fallback: false });
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
    expect(host.routerStatus()).toEqual({ name: 's', plugin: 'self-fallback', fallback: true, reason: 'router unavailable: x' });
    selfFallback = false;
    await host.router.advise(job);
    expect(host.routerStatus().fallback).toBe(false);
  });
});

describe('plugins.yaml live reload (router swaps between calls)', () => {
  it('a changed router section swaps the router; a broken edit keeps the last good one; emptying the document returns to the detected one', async () => {
    const { host, documents } = start({
      file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: first } }\n',
      builtins: [passThrough, tagging],
    });
    await host.start();
    expect(host.report().config).toMatchObject({ document: 'plugins.yaml', source: 'document' });
    expect((await host.router.advise(job)).reason).toBe('first');

    documents.set(PLUGINS, 'version: 1\nrouter: { name: two, plugin: tagging, options: { tag: second-one } }\n');
    await waitFor(async () => (await host.router.advise(job)).reason === 'second-one', { what: 'the swapped router' });
    expect(host.routerStatus()).toEqual({ name: 'two', plugin: 'tagging', fallback: false });

    documents.set(PLUGINS, 'version: 1\nrouter: [broken\n');
    await waitFor(() => host.report().config.error, { what: 'the config error' });
    expect((await host.router.advise(job)).reason).toBe('second-one');

    documents.set(PLUGINS, 'version: 1\n');
    await waitFor(() => host.routerStatus().name === 'pass-through', { what: 'the detected router' });
    expect(host.report().router).toMatchObject({ selection: 'detected' });
    expect(host.report().config.error).toBeUndefined();
    expect(await host.router.advise(job)).toMatchObject({ source: 'pass-through' });
  });

  it('reload() re-reads now', async () => {
    const { host, documents } = start({ file: 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: a } }\n' });
    await host.start();
    host.stop();
    documents.set(PLUGINS, 'version: 1\nrouter: { name: one, plugin: tagging, options: { tag: bb } }\n');
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
    expect(r.roles).toEqual(['router', 'queue-sorter', 'escalation-level', 'executor', 'job-source', 'machine-source', 'usage-source', 'notifier']);
    const byId = new Map(r.plugins.map((p) => [p.id, p]));
    expect(byId.get('gate-router')).toMatchObject({
      role: 'router', builtin: true, detection: { status: 'needs-setup' },
      options: { type: 'object', properties: { grokBotJevSrc: { type: 'string' }, python: { type: 'string' } } },
    });
    expect(byId.get('pass-through')).toMatchObject({ builtin: true, detection: { status: 'available' } });
    expect(byId.get('always-proceed')).toMatchObject({
      builtin: false, path: join(pluginDir, 'always-proceed', 'index.ts'), describe: 'Admits every job as proceed_full',
      detection: { status: 'available' }, options: { properties: { note: { type: 'string' } } },
    });
    expect(r.errors).toEqual([{ path: join(pluginDir, 'clash', 'index.js'), error: expect.stringMatching(/built-in/) }]);
  });

  it('report: an option\'s choices, as the plugin lists them from the system; a plugin that lists none has none', async () => {
    const listing: PluginDefinition<'router'> = {
      ...tagging, id: 'listing',
      async choices(sys) { return { tag: [{ value: (await sys.version('lister')) ?? '?', label: 'From the system' }] }; },
    };
    const throwing: PluginDefinition<'router'> = { ...tagging, id: 'throwing-choices', async choices() { throw new Error('cannot list'); } };
    const { host } = start({ builtins: [passThrough, listing, throwing, tagging], kit: fakeKit({ version: async () => 'v9' }) });
    await host.start();
    const byId = new Map(host.report().plugins.map((p) => [p.id, p]));
    expect(byId.get('listing')!.choices).toEqual({ tag: [{ value: 'v9', label: 'From the system' }] });
    expect(byId.get('throwing-choices')!.choices).toBeUndefined();
    expect(byId.get('tagging')!.choices).toBeUndefined();
  });

  it('a plugin whose detect throws is reported unavailable', async () => {
    const pluginDir = temp();
    writePlugin(pluginDir, 'det', "export default { id: 'det', role: 'router', describe: 'x', async detect() { throw new Error('probe failed'); }, create() {} };\n", 'index.js');
    const { host } = start({ pluginDir });
    await host.start();
    expect(host.report().plugins.find((p) => p.id === 'det')!.detection).toEqual({ status: 'unavailable', reason: expect.stringContaining('probe failed') });
  });
});

describe('escalation levels (0..n, lowest first, live)', () => {
  it('the built-in levels: opus, then fable, both claude-cli, both detected', async () => {
    const { host } = start();
    await host.start();
    expect(host.levels().map((l) => l.name)).toEqual(['opus', 'fable']);
    const r = host.report();
    expect(r.escalationLevels).toEqual([
      { instance: DEFAULT_LEVELS[0], detection: { status: 'available', detail: 'claude on machine local' }, active: 'claude-cli' },
      { instance: DEFAULT_LEVELS[1], detection: { status: 'available', detail: 'claude on machine local' }, active: 'claude-cli' },
    ]);
    expect(r.instances.filter((i) => i.role === 'escalation-level').map((i) => i.instance.name)).toEqual(['opus', 'fable']);
    const byId = new Map(r.plugins.map((p) => [p.id, p]));
    expect(byId.get('claude-cli')).toMatchObject({ role: 'escalation-level', builtin: true, options: { properties: { bin: {}, model: {}, timeoutMs: {}, effort: {} } } });
  });

  it('a level that names no machine stays in its place, cannot run, and escalates every question; shown in the report (#174)', async () => {
    const { host } = start({ file: 'version: 1\nescalationLevels: [{ name: opus, plugin: claude-cli }, { name: fable, plugin: claude-cli, options: { machine: local } }]\n' });
    await host.start();
    expect(host.levels().map((l) => l.name)).toEqual(['opus', 'fable']);
    expect(host.report().escalationLevels[0]).toMatchObject({
      instance: { name: 'opus', plugin: 'claude-cli' }, detection: { status: 'unavailable' }, active: null, reason: expect.stringContaining('machine'),
    });
    expect(await host.levels()[0]!.answer(request, new AbortController().signal)).toEqual({
      escalate: true, reason: expect.stringMatching(/^unavailable: /),
    });
  });

  it.each([
    ['an unknown plugin', '{ name: x, plugin: no-such }', /unknown escalation-level plugin no-such/],
    ['a plugin of another role', '{ name: x, plugin: pass-through }', /unknown escalation-level plugin pass-through/],
  ])('a level with %s cannot run', async (_n, entry, why) => {
    const { host } = start({ file: `version: 1\nescalationLevels: [${entry}]\n` });
    await host.start();
    expect(host.report().escalationLevels).toEqual([expect.objectContaining({ active: null, reason: expect.stringMatching(why) })]);
  });

  it('escalationLevels: [] → no levels: questions go straight to the owner', async () => {
    const { host } = start({ file: 'version: 1\nescalationLevels: []\n' });
    await host.start();
    expect(host.levels()).toEqual([]);
    expect(host.report().escalationLevels).toEqual([]);
  });

  it('plugins.yaml swaps the levels between calls', async () => {
    const { host, documents } = start();
    await host.start();
    documents.set(PLUGINS, 'version: 1\nescalationLevels: [{ name: quick, plugin: canned-level, options: { answer: yes } }, { name: opus, plugin: claude-cli }]\n');
    await waitFor(() => host.levels()[0]?.name === 'quick', { what: 'the swapped levels' });
    expect(host.levels().map((l) => l.name)).toEqual(['quick', 'opus']);
    expect(await host.levels()[0]!.answer(request, new AbortController().signal)).toEqual({ answer: 'yes', escalate: false, reason: 'canned' });
    expect(host.report().escalationLevels[0]).toMatchObject({ instance: { name: 'quick' }, active: 'canned-level' });
  });

  it.each([
    ['two levels of one name', 'escalationLevels: [{ name: a, plugin: canned-level }, { name: a, plugin: claude-cli }]', /named twice/],
    ['a level named human', 'escalationLevels: [{ name: human, plugin: canned-level }]', /human is the human stage/],
  ])('%s is a config error; the built-in levels run', async (_n, section, why) => {
    const { host } = start({ file: `version: 1\n${section}\n` });
    await host.start();
    expect(host.report().config.error).toMatch(why);
    expect(host.levels().map((l) => l.name)).toEqual(['opus', 'fable']);
  });
});
