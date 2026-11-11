// Issue #2919 through the real daemon: a claude-plan source whose `claude -p /usage` prints no usage limits (only its
// subscription line) gives no reading. The usage report says the machine's usage is unknown, with the soft lanes as its
// cap, never 0% and `free`.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageReport } from '../../src/domain/types.ts';
import { lanes as laneCount, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const FAKE_CLAUDE = join(import.meta.dirname, '..', 'plugins', 'fake-claude-plan.mjs');

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
const saved = process.env.FAKE_PLAN_DIR;
let control: string;

beforeEach(() => {
  control = mkdtempSync(join(tmpdir(), 'jh-fake-plan-'));
  process.env.FAKE_PLAN_DIR = control;
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
  if (saved === undefined) delete process.env.FAKE_PLAN_DIR; else process.env.FAKE_PLAN_DIR = saved;
});

describe('usage that cannot be read (issue #2919)', () => {
  it('no usage limits printed: the machine is unknown with the soft lanes, never 0% free', async () => {
    writeFileSync(join(control, 'mode'), 'header-only');
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const a = await startTestApp({
      dbPath: db.dbPath,
      plugins: { machines: laneCount(4), usageSources: [{ name: 'claude', plugin: 'claude-plan', options: { machine: 'local', bin: FAKE_CLAUDE, executors: ['test', 'scripted'] } }] },
    });
    apps.push(a);
    // The test app's fake usage source reads for every job: here it limits no job of this machine.
    a.user().engine.setFakeUsage({ used: 0, limit: 100, unit: '%', executors: ['elsewhere'] });
    const usage = async () => (await a.api<UsageReport>('GET', '/api/usage')).body;
    const report = await waitFor(async () => {
      const r = await usage();
      return r.sources.find((s) => s.name === 'claude')?.problem?.startsWith('usage unavailable') ? r : undefined;
    }, { what: 'the failed read' });
    expect(report.readings.filter((r) => r.source === 'claude')).toEqual([]);
    expect(report.sources.find((s) => s.name === 'claude')!.problem)
      .toBe('usage unavailable: claude printed no usage limits (Claude Code could not read them from its usage service)');
    const local = report.machines.find((m) => m.machineId === 'local')!;
    expect(local).toMatchObject({ band: 'unknown', cap: 1, unknown: ['claude'] });
    expect(local.executors.map((e) => [e.executor, e.band, e.cap])).toEqual([['test', 'unknown', 1], ['scripted', 'unknown', 1]]);

  });
});
