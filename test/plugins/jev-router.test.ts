import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Job, JobSpec } from '../../src/domain/types.ts';
import jevRouter from '../../src/plugins/router/jev-router/index.ts';
import { parseOptions } from '../../src/plugins/options.ts';
import { fakeKit, fixedClock } from './support.ts';

const JEV_SRC = join(homedir(), 'workbench/jev-src/grok-bot-jev');
/** The real-shim tests need a Jev checkout; on a machine without one they skip, not fail. */
const HAVE_JEV = existsSync(join(JEV_SRC, 'src', 'router.py'));
let dataDir: string;
const scratch: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'jh-jev-data-'));
  scratch.push(dataDir);
});
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function makeJob(spec: Partial<JobSpec> = {}): Job {
  return {
    id: 'job-1', spec: { executor: 'noop', payload: {}, ...spec }, priority: 50, status: 'queued', approved: false,
    createdAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T12:00:00.000Z', attempts: 0,
  };
}

function options(raw: Record<string, unknown> = {}) {
  const r = parseOptions(jevRouter, raw);
  if (!r.ok) throw new Error(r.error);
  return r.options as { jevSrc: string; python: string; timeoutMs: number };
}

function router(o: { jevSrc?: string; python?: string; timeoutMs?: number } = {}) {
  const ctx = { clock: fixedClock, logger: { info() {}, warn() {} }, dataDir, scratchDir: dataDir, routerMode: () => 'shadow' as const };
  return jevRouter.create(ctx, options({ jevSrc: o.jevSrc ?? JEV_SRC, ...o }));
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '.git') walk(p);
      } else {
        const s = statSync(p);
        out.push(`${p}:${s.size}:${s.mtimeMs}`);
      }
      if (e.name === '__pycache__') out.push(`PYCACHE:${p}`);
    }
  };
  walk(root);
  return out.sort();
}

describe('jev-router options and detection', () => {
  it('defaults: the Jev checkout under ~/workbench, python3, 10 s', () => {
    expect(options()).toEqual({ jevSrc: '~/workbench/jev-src/grok-bot-jev', python: 'python3', timeoutMs: 10000 });
  });

  it('available when python and the Jev router are present', async () => {
    const seen: string[] = [];
    const kit = fakeKit({ exists: async (p) => { seen.push(p); return true; } });
    expect(await jevRouter.detect(kit, options({ jevSrc: '/jev' }))).toMatchObject({ status: 'available' });
    expect(seen).toContain('/jev/src/router.py');
  });

  it('expands ~ in jevSrc', async () => {
    const seen: string[] = [];
    await jevRouter.detect(fakeKit({ exists: async (p) => { seen.push(p); return true; } }), options());
    expect(seen).toContain(join(JEV_SRC, 'src', 'router.py'));
  });

  it('unavailable without the Jev checkout', async () => {
    const d = await jevRouter.detect(fakeKit({ exists: async () => false }), options({ jevSrc: '/nowhere' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('/nowhere/src/router.py') });
  });

  it('unavailable without python', async () => {
    const d = await jevRouter.detect(fakeKit({ which: async () => undefined }), options({ python: 'python9' }));
    expect(d).toEqual({ status: 'unavailable', reason: expect.stringContaining('python9') });
  });
});

describe.skipIf(!HAVE_JEV)('jev-router, real shim (needs a Jev checkout)', () => {
  it('kill switch: proceed_full via the real router, nothing written under the Jev repo', async () => {
    const before = snapshot(JEV_SRC);
    const advice = await (await router()).advise(makeJob({ goal: 'check status', kind: 'lookup' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'jev-router', at: '2026-10-03T12:00:00.000Z' });
    expect(advice.details.jevUsed).toBe(false);
    expect(advice.reason).toContain('disabled or bypass');
    expect(snapshot(JEV_SRC)).toEqual(before);
    expect(before.some((l) => l.startsWith('PYCACHE'))).toBe(false);

    const log = join(dataDir, 'jev-runs.jsonl');
    expect(existsSync(log)).toBe(true);
    const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0]!);
    expect(line).toMatchObject({ event: 'route', state_goal: 'check status', mode: 'shadow' });
  });

  it('enabled Jev without typesafe_sdk falls back', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'jh-jev-copy-'));
    scratch.push(copy);
    cpSync(JEV_SRC, copy, { recursive: true });
    const cfg = join(copy, 'config.yaml');
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^enabled: false/m, 'enabled: true'));
    const advice = await (await router({ jevSrc: copy })).advise(makeJob({ goal: 'research x', kind: 'research' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', details: { jevUsed: false } });
    expect(advice.reason).toMatch(/^jev unavailable: .*typesafe_sdk not installed/);
  });
});

describe('jev-router failures fall back (no Jev checkout needed)', () => {
  it('missing python binary falls back', async () => {
    const advice = await (await router({ python: '/nonexistent/python' })).advise(makeJob());
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', details: { jevUsed: false } });
    expect(advice.reason).toMatch(/^jev unavailable: /);
  });

  it('timeout falls back', async () => {
    const slow = join(dataDir, 'slow-python');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    chmodSync(slow, 0o755);
    const started = Date.now();
    const advice = await (await router({ python: slow, timeoutMs: 200 })).advise(makeJob());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(advice).toMatchObject({ source: 'fallback', details: { jevUsed: false } });
    expect(advice.reason).toContain('timed out');
  });

  it('bad JSON from the interpreter falls back', async () => {
    const junk = join(dataDir, 'junk-python');
    writeFileSync(junk, '#!/bin/sh\necho not-json\n');
    chmodSync(junk, 0o755);
    const advice = await (await router({ python: junk })).advise(makeJob());
    expect(advice.source).toBe('fallback');
  });
});
