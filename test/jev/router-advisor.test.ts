import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouterAdvisor } from '../../src/jev/index.ts';
import { fixedClock, makeJob } from './support.ts';

const JEV_SRC = join(homedir(), 'workbench/jev-src/grok-bot-jev');
let dataDir: string;
const scratch: string[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'jh-jev-data-'));
  scratch.push(dataDir);
});
afterEach(() => {
  while (scratch.length) rmSync(scratch.pop()!, { recursive: true, force: true });
});

function advisor(o: { jevSrc?: string; python?: string; timeoutMs?: number } = {}) {
  return createRouterAdvisor({
    jevSrc: o.jevSrc ?? JEV_SRC,
    python: o.python ?? 'python3',
    dataDir,
    mode: () => 'shadow',
    clock: fixedClock,
    timeoutMs: o.timeoutMs,
  });
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

describe('router advisor, real shim', () => {
  it('kill switch: proceed_full via the real router, nothing written under the Jev repo', async () => {
    const before = snapshot(JEV_SRC);
    const advice = await advisor().advise(makeJob({ goal: 'check status', kind: 'lookup' }));
    expect(advice).toMatchObject({
      action: 'proceed_full',
      source: 'jev-router',
      jevUsed: false,
      at: '2026-10-02T12:00:00.000Z',
    });
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
    writeFileSync(cfg, readFileSync(cfg, 'utf8').replace('enabled: false', 'enabled: true'));
    const advice = await advisor({ jevSrc: copy }).advise(makeJob({ goal: 'research x', kind: 'research' }));
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', jevUsed: false, details: {} });
    expect(advice.reason).toMatch(/^jev unavailable: .*typesafe_sdk not installed/);
  });

  it('missing python binary falls back', async () => {
    const advice = await advisor({ python: '/nonexistent/python' }).advise(makeJob());
    expect(advice).toMatchObject({ action: 'proceed_full', source: 'fallback', jevUsed: false });
    expect(advice.reason).toMatch(/^jev unavailable: /);
  });

  it('timeout falls back', async () => {
    const slow = join(dataDir, 'slow-python');
    writeFileSync(slow, '#!/bin/sh\nsleep 5\n');
    chmodSync(slow, 0o755);
    const started = Date.now();
    const advice = await advisor({ python: slow, timeoutMs: 200 }).advise(makeJob());
    expect(Date.now() - started).toBeLessThan(3000);
    expect(advice).toMatchObject({ source: 'fallback', jevUsed: false });
    expect(advice.reason).toContain('timed out');
  });

  it('bad JSON from the interpreter falls back', async () => {
    const junk = join(dataDir, 'junk-python');
    writeFileSync(junk, '#!/bin/sh\necho not-json\n');
    chmodSync(junk, 0o755);
    const advice = await advisor({ python: junk }).advise(makeJob());
    expect(advice.source).toBe('fallback');
  });
});
