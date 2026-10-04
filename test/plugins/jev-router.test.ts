// jev-router: Jev's own router, run through jev_shim.py against a stand-in Jev checkout
// (fixtures/jev), a fake `claude` (Haiku) and a fake typesafe_sdk (TypeSafe). TypeSafe answers the
// Jev gates named in `typesafeGates` once TYPESAFE_API_KEY is set; Haiku answers the rest, and every
// gate while TypeSafe is off or failing.
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobSpec } from '../../src/domain/types.ts';
import jevRouter from '../../src/plugins/router/jev-router/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { fakeKit, fixedClock } from './support.ts';

const JEV = join(import.meta.dirname, 'fixtures', 'jev');
const FAKE_TYPESAFE = join(import.meta.dirname, 'fixtures', 'fake-typesafe');
const CLAUDE = join(import.meta.dirname, 'fake-claude.mjs');
const KEYS = ['CLAUDECODE', 'FAKE_CLAUDE_OUT', 'FAKE_CLAUDE_MODE', 'FAKE_CLAUDE_STRUCTURED', 'FAKE_TYPESAFE_OUT', 'FAKE_TYPESAFE_MODE', 'TYPESAFE_API_KEY', 'PYTHONPATH'];
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
  for (const k of ['FAKE_CLAUDE_MODE', 'FAKE_TYPESAFE_MODE', 'TYPESAFE_API_KEY', 'PYTHONPATH']) delete process.env[k];
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

/** TypeSafe reachable: a key and an importable typesafe_sdk (the fake). */
function typesafeOn() {
  process.env.TYPESAFE_API_KEY = 'ts-test';
  process.env.PYTHONPATH = FAKE_TYPESAFE;
}

function makeJob(spec: Partial<JobSpec> = {}): Job {
  return {
    id: 'job-1', spec: { executor: 'noop', payload: {}, ...spec }, priority: 50, status: 'queued', approved: false,
    createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z', attempts: 0,
  };
}

type Opts = { jevSrc: string; python: string; claudeBin: string; model: string; typesafeGates: string[]; timeoutMs: number };

function options(raw: Record<string, unknown> = {}): Opts {
  const r = parseOptions(jevRouter, raw);
  if (!r.ok) throw new Error(r.error);
  return r.options as Opts;
}

function router(o: Partial<Opts> = {}) {
  const ctx = { clock: fixedClock, logger: { info() {}, warn() {} }, dataDir, scratchDir: dataDir, instanceName: 'jev', routerMode: () => 'shadow' as const };
  return jevRouter.create(ctx, options({ jevSrc: JEV, claudeBin: CLAUDE, ...o }));
}

const claudeCall = () => JSON.parse(readFileSync(process.env.FAKE_CLAUDE_OUT!, 'utf8')) as { argv: string[]; stdin: string; env: Record<string, string>; cwd: string };
const typesafeCall = () => JSON.parse(readFileSync(process.env.FAKE_TYPESAFE_OUT!, 'utf8')) as { questions: string[]; model: string };

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

describe('jev-router options and detection', () => {
  it('defaults: the Jev checkout under ~/workbench, python3, Haiku through claude, TypeSafe for the crisp gates, 60 s', () => {
    expect(options()).toEqual({
      jevSrc: '~/workbench/jev-src/grok-bot-jev', python: 'python3', claudeBin: 'claude', model: 'haiku',
      typesafeGates: ['intent', 'reuse_cache', 'stop_retry'], timeoutMs: 60000,
    });
  });

  it('available when python, the Jev router and claude are present; says TypeSafe is off without a key', async () => {
    const seen: string[] = [];
    const kit = fakeKit({ exists: async (p) => { seen.push(p); return true; } });
    const d = await jevRouter.detect(kit, options({ jevSrc: '/jev' }));
    expect(d).toMatchObject({ status: 'available', detail: expect.stringContaining('TypeSafe off: TYPESAFE_API_KEY unset') });
    expect(seen).toContain('/jev/src/router.py');
  });

  it('says TypeSafe is on with a key and typesafe_sdk', async () => {
    const kit = fakeKit({ env: (n) => (n === 'TYPESAFE_API_KEY' ? 'k' : undefined), pythonImports: async () => true });
    expect(await jevRouter.detect(kit, options({ jevSrc: '/jev' }))).toMatchObject({ status: 'available', detail: expect.stringContaining('TypeSafe on (intent, reuse_cache, stop_retry)') });
  });

  it('says TypeSafe is off with a key but no typesafe_sdk', async () => {
    const kit = fakeKit({ env: (n) => (n === 'TYPESAFE_API_KEY' ? 'k' : undefined), pythonImports: async () => false });
    expect(await jevRouter.detect(kit, options({ python: 'py' }))).toMatchObject({ detail: expect.stringContaining('TypeSafe off: py cannot import typesafe_sdk') });
  });

  it('unavailable without the Jev checkout', async () => {
    const d = await jevRouter.detect(fakeKit({ exists: async () => false }), options({ jevSrc: '/nowhere' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('/nowhere/src/router.py') });
  });

  it('unavailable without python', async () => {
    const d = await jevRouter.detect(fakeKit({ which: async (b) => (b === 'python9' ? undefined : `/usr/bin/${b}`) }), options({ python: 'python9' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('python9') });
  });

  it('unavailable without claude', async () => {
    const d = await jevRouter.detect(fakeKit({ which: async (b) => (b === 'claude9' ? undefined : `/usr/bin/${b}`) }), options({ claudeBin: 'claude9' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('claude9') });
  });
});

describe('jev-router classifies through Jev', () => {
  it('kill switch: proceed_full from the router itself, neither TypeSafe nor Haiku asked', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'jh-jev-copy-'));
    scratch.push(copy);
    cpSync(JEV, copy, { recursive: true });
    writeFileSync(join(copy, 'config.json'), '{"enabled": false}');
    const advice = await (await router({ jevSrc: copy })).advise(makeJob({ goal: 'check status' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'jev-router', details: { jevUsed: false } });
    expect(existsSync(process.env.FAKE_CLAUDE_OUT!)).toBe(false);
  });

  it('TypeSafe off: Haiku answers every gate, locked down, and Jev routes on its answers', async () => {
    const before = snapshot(JEV);
    const advice = await (await router()).advise(makeJob({ goal: 'check the deploy status', kind: 'lookup' }));
    expect(advice).toMatchObject({
      action: 'run_deterministic', source: 'jev-router', at: '2026-10-03T12:00:00.000Z',
      details: {
        jevUsed: true, intent: 'lookup', intent_confidence: 0.8, needs_subagent: 0.2, complexity_0_1: 0.5,
        gatesBy: { intent: 'haiku', reuse_cache: 'haiku', needs_subagent: 'haiku', stop_retry: 'haiku', complexity: 'haiku' },
      },
    });
    expect(advice.details).not.toHaveProperty('typesafeError');
    const c = claudeCall();
    expect(c.argv.slice(0, 3)).toEqual(['-p', '--model', 'haiku']);
    expect(c.argv).toEqual(expect.arrayContaining(['--json-schema', '--no-session-persistence', '--strict-mcp-config']));
    expect(c.argv.slice(-2)).toEqual(['--tools', '']);
    expect(c.env.CLAUDECODE).toBeUndefined();
    expect(c.cwd).toBe(dataDir);
    for (const s of ['check the deploy status', 'intent', 'lookup', 'a status check', 'complexity', 'Heavy', 'stop_retry']) expect(c.stdin).toContain(s);
    expect(existsSync(process.env.FAKE_TYPESAFE_OUT!)).toBe(false);
    expect(snapshot(JEV)).toEqual(before);
    expect(readFileSync(join(dataDir, 'jev-runs.jsonl'), 'utf8')).toContain('check the deploy status');
  });

  it('TypeSafe on: it answers the gates in `typesafeGates`, Haiku the rest', async () => {
    typesafeOn();
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ choices: {}, nouls: { needs_subagent: 0.2 }, scores: { complexity: 2 } });
    const advice = await (await router()).advise(makeJob({ goal: 'fix the login form' }));
    expect(typesafeCall()).toEqual({ questions: ['intent', 'reuse_cache', 'stop_retry'], model: 'jev-latest', state: { goal: 'fix the login form' } });
    expect(claudeCall().stdin).not.toContain('reuse_cache');
    expect(claudeCall().stdin).toContain('needs_subagent');
    expect(advice).toMatchObject({
      action: 'run_deterministic', source: 'jev-router',
      details: {
        intent: 'lookup', intent_confidence: 0.9, reuse_cache: 0.11, stop_retry: 0.11, needs_subagent: 0.2, complexity_0_1: 1,
        gatesBy: { intent: 'typesafe', reuse_cache: 'typesafe', stop_retry: 'typesafe', needs_subagent: 'haiku', complexity: 'haiku' },
      },
    });
  });

  it('TypeSafe on for every gate: Haiku is not asked', async () => {
    typesafeOn();
    const advice = await (await router({ typesafeGates: ['intent', 'reuse_cache', 'needs_subagent', 'stop_retry', 'complexity'] })).advise(makeJob({ goal: 'g' }));
    expect(Object.values(advice.details.gatesBy as Record<string, string>)).toEqual(Array(5).fill('typesafe'));
    expect(existsSync(process.env.FAKE_CLAUDE_OUT!)).toBe(false);
  });

  it('TypeSafe failing: Haiku answers its gates too, and the error is in the advice', async () => {
    typesafeOn();
    process.env.FAKE_TYPESAFE_MODE = 'error';
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ source: 'jev-router', details: { gatesBy: { intent: 'haiku', reuse_cache: 'haiku' }, typesafeError: expect.stringContaining('401 invalid api key') } });
  });

  it('key set but no typesafe_sdk: Haiku answers, TypeSafe is skipped', async () => {
    process.env.TYPESAFE_API_KEY = 'ts-test';
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ source: 'jev-router', details: { gatesBy: { intent: 'haiku' }, typesafeError: expect.stringContaining('typesafe_sdk not installed') } });
  });
});

describe('jev-router failures fall back', () => {
  it('Haiku choosing a label Jev did not offer falls back', async () => {
    process.env.FAKE_CLAUDE_STRUCTURED = JSON.stringify({ ...HAIKU_ALL, choices: { intent: { choice: 'dance', probabilities: { dance: 1 } } } });
    const advice = await (await router()).advise(makeJob({ goal: 'g' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', details: { jevUsed: false } });
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
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', details: { jevUsed: false } });
    expect(advice.reason).toMatch(/^jev unavailable: /);
  });

  it('timeout falls back and kills what the interpreter started', async () => {
    const slow = join(dataDir, 'slow-python');
    const pidFile = join(dataDir, 'child.pid');
    writeFileSync(slow, `#!/bin/sh\nsleep 30 &\necho $! > ${pidFile}\nwait\n`);
    chmodSync(slow, 0o755);
    const started = Date.now();
    const advice = await (await router({ python: slow, timeoutMs: 500 })).advise(makeJob());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(advice).toMatchObject({ source: 'fallback', details: { jevUsed: false } });
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
