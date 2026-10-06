// gate-router: a router that runs grok-bot-jev's gates, through gate_shim.py against a stand-in
// grok-bot-jev checkout (fixtures/grok-bot-jev), a fake `claude` on PATH (the Claude model, Haiku) and a
// fake typesafe_sdk (Jev through TypeSafe). Jev answers its gates (intent, reuse_cache, stop_retry) once
// the TypeSafe key is set; the Claude model answers the rest, and every gate while Jev is off or failing.
// The key comes from the daemon's environment (TYPESAFE_API_KEY), asked on every call.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobSpec } from '../../src/domain/types.ts';
import gateRouter from '../../src/plugins/router/gate-router/index.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import { fakeKit, fixedClock } from './support.ts';

const CHECKOUT = join(import.meta.dirname, 'fixtures', 'grok-bot-jev');
const FAKE_TYPESAFE = join(import.meta.dirname, 'fixtures', 'fake-typesafe');
const CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const KEYS = ['CLAUDECODE', 'FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_STRUCTURED', 'FAKE_TYPESAFE_OUT', 'FAKE_TYPESAFE_MODE', 'TYPESAFE_API_KEY', 'PYTHONPATH', 'PATH'];
const saved: Record<string, string | undefined> = {};
let dataDir: string;
const scratch: string[] = [];

/** Haiku's answer to every fixture gate: intent lookup. */
const HAIKU_ALL = {
  choices: { intent: { choice: 'lookup', probabilities: { lookup: 0.8, coding: 0.2 } } },
  nouls: { reuse_cache: 0.1, needs_subagent: 0.2, stop_retry: 0.3 },
  scores: { complexity: 1 },
};

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  dataDir = mkdtempSync(join(tmpdir(), 'jh-jev-data-'));
  scratch.push(dataDir);
  process.env.FAKE_CLAUDE_OUT = join(dataDir, 'claude.json');
  process.env.FAKE_TYPESAFE_OUT = join(dataDir, 'typesafe.json');
  process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify(HAIKU_ALL);
  process.env.CLAUDECODE = '1';
  // The router runs the `claude` on PATH: here, the fake.
  const bin = join(dataDir, 'bin');
  mkdirSync(bin);
  symlinkSync(CLAUDE, join(bin, 'claude'));
  process.env.PATH = `${bin}:${saved.PATH ?? ''}`;
  for (const k of ['FAKE_CLAUDE_MODE', 'FAKE_TYPESAFE_MODE', 'TYPESAFE_API_KEY', 'PYTHONPATH']) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** Jev reachable: a TypeSafe key and an importable typesafe_sdk (the fake). */
function jevOn() {
  process.env.TYPESAFE_API_KEY = 'ts-test';
  process.env.PYTHONPATH = FAKE_TYPESAFE;
}

function makeJob(spec: Partial<JobSpec> = {}): Job {
  return {
    id: 'job-1', spec: { executor: 'noop', payload: {}, ...spec }, priority: 50, status: 'queued', approved: false,
    createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z', attempts: 0,
  };
}

type Opts = { jevPath: string; python: string; model: string; timeoutSeconds: number };

function options(raw: Record<string, unknown> = {}): Opts {
  const r = parseOptions(gateRouter, raw);
  if (!r.ok) throw new Error(r.error);
  return r.options as Opts;
}

function router(o: Partial<Opts> = {}) {
  const ctx = { clock: fixedClock, logger: { info() {}, warn() {} }, dataDir, userEnv: {}, scratchDir: dataDir, instanceName: 'jev', env: (n: string) => process.env[n], routerMode: () => 'shadow' as const };
  return gateRouter.create(ctx, options({ jevPath: CHECKOUT, ...o }));
}

const claudeCall = () => JSON.parse(readFileSync(process.env.FAKE_CLAUDE_OUT!, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; cwd: string };
const typesafeCall = () => JSON.parse(readFileSync(process.env.FAKE_TYPESAFE_OUT!, 'utf8')) as { questions: string[]; model: string; key: string | null };

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).size}:${statSync(p).mtimeMs}`);
      if (e.name === '__pycache__') out.push(`PYCACHE:${p}`);
    }
  };
  walk(root);
  return out.sort();
}

describe('gate-router options and detection', () => {
  it('settings: where Jev is, the Python that runs it, the Claude model, a timeout in seconds; jevPath has no default', () => {
    expect(parseOptions(gateRouter, {})).toEqual({ ok: false, error: expect.stringMatching(/jevPath/) });
    expect(options({ jevPath: '/jev' })).toEqual({ jevPath: '/jev', python: 'python3', model: 'haiku', timeoutSeconds: 60 });
  });

  it('every setting is described; none is a leftover (no claudeBin, no jevGates)', () => {
    const schema = optionsJsonSchema(gateRouter) as { properties: Record<string, { description?: string }> };
    expect(Object.keys(schema.properties).sort()).toEqual(['jevPath', 'model', 'python', 'timeoutSeconds']);
    for (const [name, p] of Object.entries(schema.properties)) expect(p.description, name).toEqual(expect.any(String));
  });

  it('where Jev is and its Python are command-bearing', async () => {
    const { commandBearingKeys } = await import('../../src/plugins/edit.ts');
    expect([...commandBearingKeys(gateRouter)].sort()).toEqual(['jevPath', 'python']);
  });

  it('available when python, the grok-bot-jev router and claude are present; says Jev is off without a key', async () => {
    const seen: string[] = [];
    const kit = fakeKit({ exists: async (p) => { seen.push(p); return true; } });
    const d = await gateRouter.detect(kit, options({ jevPath: '/jev' }));
    expect(d).toMatchObject({ status: 'available', detail: expect.stringMatching(/Jev off until TYPESAFE_API_KEY is set; Claude haiku answers the other gates/) });
    expect(seen).toContain('/jev/src/router.py');
  });

  it('says Jev is on with a key and typesafe_sdk', async () => {
    const kit = fakeKit({ env: (n) => (n === 'TYPESAFE_API_KEY' ? 'k' : undefined), pythonImports: async () => true });
    expect(await gateRouter.detect(kit, options({ jevPath: '/jev' }))).toMatchObject({ status: 'available', detail: expect.stringContaining('Jev through TypeSafe for intent, reuse_cache, stop_retry') });
  });

  it('says Jev is off with a key but no typesafe_sdk', async () => {
    const kit = fakeKit({ env: (n) => (n === 'TYPESAFE_API_KEY' ? 'k' : undefined), pythonImports: async () => false });
    expect(await gateRouter.detect(kit, options({ jevPath: '/jev', python: 'py' }))).toMatchObject({ detail: expect.stringContaining('Jev off: py cannot import typesafe_sdk') });
  });

  it('unavailable without the grok-bot-jev checkout', async () => {
    const d = await gateRouter.detect(fakeKit({ exists: async () => false }), options({ jevPath: '/nowhere' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('/nowhere/src/router.py') });
  });

  it('unavailable without python', async () => {
    const d = await gateRouter.detect(fakeKit({ which: async (b) => (b === 'python9' ? undefined : `/usr/bin/${b}`) }), options({ jevPath: '/jev', python: 'python9' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('python9') });
  });

  it('unavailable without claude on PATH', async () => {
    const d = await gateRouter.detect(fakeKit({ which: async (b) => (b === 'claude' ? undefined : `/usr/bin/${b}`) }), options({ jevPath: '/jev' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('claude not found') });
  });
});

describe('gate-router asks grok-bot-jev\'s gates', () => {
  it('kill switch: proceed_full from the router itself, neither Jev nor Haiku asked', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'jh-jev-copy-'));
    scratch.push(copy);
    cpSync(CHECKOUT, copy, { recursive: true });
    writeFileSync(join(copy, 'config.json'), '{"enabled": false}');
    const advice = await (await router({ jevPath: copy })).advise(makeJob({ goal: 'check status' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'gate-router', details: { gatesAsked: false } });
    expect(existsSync(process.env.FAKE_CLAUDE_OUT!)).toBe(false);
  });

  it('Jev off: Haiku answers every gate, locked down, and the router routes on its answers', async () => {
    const before = snapshot(CHECKOUT);
    const advice = await (await router()).advise(makeJob({ goal: 'check the deploy status', kind: 'lookup' }));
    expect(advice).toMatchObject({
      action: 'run_deterministic', source: 'gate-router', at: '2026-10-03T12:00:00.000Z',
      details: {
        gatesAsked: true, intent: 'lookup', intent_confidence: 0.8, needs_subagent: 0.2, complexity_0_1: 0.5,
        gatesBy: { intent: 'claude', reuse_cache: 'claude', needs_subagent: 'claude', stop_retry: 'claude', complexity: 'claude' },
      },
    });
    expect(advice.details).not.toHaveProperty('jevError');
    const c = claudeCall();
    expect(c.argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(c.argv).toEqual(expect.arrayContaining(['--json-schema', '--no-session-persistence', '--strict-mcp-config']));
    expect(c.argv.slice(-2)).toEqual(['--tools', '']);
    expect(c.env.CLAUDECODE).toBeUndefined();
    expect(c.cwd).toBe(dataDir);
    for (const s of ['check the deploy status', 'intent', 'lookup', 'a status check', 'complexity', 'Heavy', 'stop_retry']) expect(c.stdin).toContain(s);
    expect(existsSync(process.env.FAKE_TYPESAFE_OUT!)).toBe(false);
    expect(snapshot(CHECKOUT)).toEqual(before);
    expect(readFileSync(join(dataDir, 'gate-router-runs.jsonl'), 'utf8')).toContain('check the deploy status');
  });

  it('Jev on: it answers intent, reuse_cache and stop_retry, Haiku the rest', async () => {
    jevOn();
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ choices: {}, nouls: { needs_subagent: 0.2 }, scores: { complexity: 2 } });
    const advice = await (await router()).advise(makeJob({ goal: 'fix the login form' }));
    expect(typesafeCall()).toEqual({ questions: ['intent', 'reuse_cache', 'stop_retry'], model: 'jev-latest', state: { goal: 'fix the login form' }, key: 'ts-test' });
    expect(claudeCall().stdin).not.toContain('reuse_cache');
    expect(claudeCall().stdin).toContain('needs_subagent');
    expect(advice).toMatchObject({
      action: 'run_deterministic', source: 'gate-router',
      details: {
        intent: 'lookup', intent_confidence: 0.9, reuse_cache: 0.11, stop_retry: 0.11, needs_subagent: 0.2, complexity_0_1: 1,
        gatesBy: { intent: 'jev', reuse_cache: 'jev', stop_retry: 'jev', needs_subagent: 'claude', complexity: 'claude' },
      },
    });
  });

  it('setting the key switches Jev on for the next call, no restart', async () => {
    process.env.PYTHONPATH = FAKE_TYPESAFE;
    const jev = await router();
    const before = await jev.advise(makeJob({ goal: 'g' }));
    expect(before.details).toMatchObject({ gatesBy: { intent: 'claude', reuse_cache: 'claude', stop_retry: 'claude' } });
    expect(before.details).not.toHaveProperty('jevError');
    expect(existsSync(process.env.FAKE_TYPESAFE_OUT!)).toBe(false);

    process.env.TYPESAFE_API_KEY = 'ts-later';
    const after = await jev.advise(makeJob({ goal: 'g' }));
    expect(after.details).toMatchObject({ gatesBy: { intent: 'jev', reuse_cache: 'jev', stop_retry: 'jev', needs_subagent: 'claude' } });
    expect(typesafeCall().key).toBe('ts-later');
  });

  it('an empty key leaves Jev off', async () => {
    process.env.PYTHONPATH = FAKE_TYPESAFE;
    process.env.TYPESAFE_API_KEY = '';
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice.details).toMatchObject({ gatesBy: { intent: 'claude' } });
    expect(advice.details).not.toHaveProperty('jevError');
  });

  it('Jev failing: Haiku answers its gates too, and the error is in the advice', async () => {
    jevOn();
    process.env.FAKE_TYPESAFE_MODE = 'error';
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ source: 'gate-router', details: { gatesBy: { intent: 'claude', reuse_cache: 'claude' }, jevError: expect.stringContaining('401 invalid api key') } });
  });

  it('key set but no typesafe_sdk: Haiku answers, Jev is skipped', async () => {
    process.env.TYPESAFE_API_KEY = 'ts-test';
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ source: 'gate-router', details: { gatesBy: { intent: 'claude' }, jevError: expect.stringContaining('typesafe_sdk not installed') } });
  });
});

describe('gate-router failures fall back', () => {
  it('Haiku choosing a label the gate did not offer falls back', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ ...HAIKU_ALL, choices: { intent: { choice: 'dance', probabilities: { dance: 1 } } } });
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', details: { gatesAsked: false } });
    expect(advice.reason).toContain('dance');
  });

  it('Haiku leaving a gate unanswered falls back', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ ...HAIKU_ALL, nouls: { reuse_cache: 0.1 } });
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ source: 'fallback' });
    expect(advice.reason).toContain('needs_subagent');
  });

  it('claude failing falls back with its stderr', async () => {
    process.env.FAKE_CLAUDE_MODE = 'exit1';
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ source: 'fallback' });
    expect(advice.reason).toContain('auth failed');
  });

  it('missing python binary falls back', async () => {
    const advice = await (await router({ python: '/nonexistent/python' })).advise(makeJob());
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', details: { gatesAsked: false } });
    expect(advice.reason).toMatch(/^gate router unavailable: /);
  });

  it('timeout falls back and kills what the interpreter started', async () => {
    const slow = join(dataDir, 'slow-python');
    const pidFile = join(dataDir, 'child.pid');
    writeFileSync(slow, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(slow, 0o755);
    const started = Date.now();
    const advice = await (await router({ python: slow, timeoutSeconds: 0.5 })).advise(makeJob());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(advice).toMatchObject({ source: 'fallback', details: { gatesAsked: false } });
    expect(advice.reason).toContain('timed out');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    await new Promise((r) => setTimeout(r, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('bad JSON from the interpreter falls back', async () => {
    const junk = join(dataDir, 'junk-python');
    writeFileSync(junk, '#!/bin/sh\necho not-json\n');
    chmodSync(junk, 0o755);
    const advice = await (await router({ python: junk })).advise(makeJob());
    expect(advice.source).toBe('fallback');
  });
});
