// Phase 5 slice 3: the built-in executor plugins (herdr-claude, test) — options, detection (cheap:
// `which` only, never a model call, never a GUI), create — and the command-bearing mark on every
// option that names a program, its arguments, a working directory or an interpreter.
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import claudeCli from '../../src/plugins/escalation-level/claude-cli/index.ts';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';
import herdrClaude, { herdrClaudePlugin } from '../../src/plugins/executor/herdr-claude/index.ts';
import testExecutor from '../../src/plugins/executor/test/index.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import gateRouter from '../../src/plugins/router/gate-router/index.ts';
import type { PluginDefinition, Role } from '../../src/plugins/sdk.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { fakeKit, fixedClock, useTempDirs } from './support.ts';

const temp = useTempDirs();
const logger = { info() {}, warn() {} };
const ctx = (dir: string) => ({ clock: fixedClock, logger, dataDir: dir, scratchDir: join(dir, 'scratch'), instanceName: 'x', env: () => undefined });

/** The options `def` would get from `raw`, as its own options type. */
function options<O>(def: PluginDefinition<Role, O>, raw: unknown = {}): O {
  const r = parseOptions(def, raw);
  if (!r.ok) throw new Error(r.error);
  return r.options as O;
}

/** The options' JSON Schema properties, as /api/plugins shows them. */
const props = (def: PluginDefinition) => (optionsJsonSchema(def) as { properties: Record<string, Record<string, unknown>> }).properties;

describe('built-in executor plugins are listed', () => {
  it('herdr-claude, command and test, role executor', () => {
    const executors = BUILTIN_PLUGINS.filter((p) => p.role === 'executor').map((p) => p.id).sort();
    expect(executors).toEqual(['command', 'herdr-claude', 'test']);
  });
});

describe('herdr-claude', () => {
  it('options default to what the env defaulted to before plugins', () => {
    expect(options(herdrClaude)).toEqual({
      bin: 'herdr', claudeBin: 'claude', session: 'hopper', args: ['--dangerously-skip-permissions'],
      cwd: homedir(), trustWorkdir: true, pollMs: 1000, idleQuestionMs: 20000,
    });
  });

  it('expands ~ in cwd and refuses the default herdr session', () => {
    expect(options(herdrClaude, { cwd: '~/w' }).cwd).toBe(join(homedir(), 'w'));
    expect(parseOptions(herdrClaude, { session: 'default' })).toEqual({ ok: false, error: expect.stringMatching(/session/) });
  });

  it('detect: herdr and the claude CLI on PATH → available; `which` only', async () => {
    const which = vi.fn(async (bin: string) => `/usr/bin/${bin}`);
    const version = vi.fn(async () => '1');
    const d = await herdrClaude.detect(fakeKit({ which, version }), options(herdrClaude, { bin: 'herdr', claudeBin: 'claude' }));
    expect(d).toEqual({ status: 'available', detail: expect.stringContaining('/usr/bin/herdr') });
    expect(which.mock.calls.map((c) => c[0]).sort()).toEqual(['claude', 'herdr']);
    expect(version).not.toHaveBeenCalled();
  });

  it.each([
    ['herdr missing', 'herdr', /herdr not found: herdr/],
    ['claude missing', 'claude', /claude not found: claude/],
  ])('detect: %s → unavailable', async (_n, missing, why) => {
    const kit = fakeKit({ which: async (bin) => (bin === missing ? undefined : `/usr/bin/${bin}`) });
    expect(await herdrClaude.detect(kit, options(herdrClaude))).toEqual({ status: 'unavailable', reason: expect.stringMatching(why) });
  });

  it('create: a herdr-claude executor over the herdr CLI (nothing runs until a job does)', async () => {
    const ex = await herdrClaude.create(ctx(temp()), options(herdrClaude, { bin: '/nonexistent/herdr' }));
    expect(ex).toMatchObject({ name: 'herdr-claude', idempotent: false });
    expect(ex.validate({ prompt: 'p', cwd: '/tmp' })).toBeNull();
  });

  it('with a HerdrClient seam (tests): available whatever is installed, and the seam is driven', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [] });
    const seamed = herdrClaudePlugin(herdr);
    expect(seamed.id).toBe('herdr-claude');
    expect(await seamed.detect(fakeKit({ which: async () => undefined }), options(seamed))).toMatchObject({ status: 'available' });
    const ex = await seamed.create(ctx(temp()), options(seamed));
    expect(ex.name).toBe('herdr-claude');
  });
});

describe('test', () => {
  it('no options, always available, creates the test executor', async () => {
    expect(options(testExecutor)).toEqual({});
    expect(await testExecutor.detect(fakeKit({ which: async () => undefined }), {})).toEqual({ status: 'available' });
    const ex = await testExecutor.create(ctx(temp()), {});
    expect(ex).toMatchObject({ name: 'test', idempotent: true });
    expect(ex.validate({ op: 'echo' })).toBeNull();
  });
});

describe('command-bearing options carry the mark into JSON Schema (design.md "UI and mutation")', () => {
  it.each([
    ['herdr-claude', herdrClaude, ['bin', 'claudeBin', 'args', 'cwd']],
    ['claude-cli', claudeCli, ['bin']],
    ['gate-router', gateRouter, ['grokBotJevSrc', 'python', 'claudeBin']],
  ] as [string, PluginDefinition, string[]][])('%s', (_id, def, marked) => {
    const p = props(def);
    const bearing = Object.keys(p).filter((k) => p[k]!.commandBearing === true).sort();
    expect(bearing).toEqual([...marked].sort());
  });
});
