// The built-in usage source `command-usage` (design.md "Usage per executor (issue #140)"): budget
// readings and the account of any agent framework, from a command that prints them as JSON. Runs
// against a fake command (fake-usage-command.mjs).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageSource } from '../../src/domain/ports.ts';
import { optionsJsonSchema, parseOptions } from '../../src/plugins/options.ts';
import commandUsage from '../../src/plugins/usage-source/command-usage/index.ts';
import { waitFor } from '../support/wait.ts';
import { fakeKit, useTempDirs } from './support.ts';

const BIN = join(import.meta.dirname, 'fake-usage-command.mjs');

describe('command-usage plugin', () => {
  const temp = useTempDirs();
  let control: string;
  let scratch: string;
  let now: Date;
  const sources: UsageSource[] = [];
  const saved = process.env.FAKE_USAGE_DIR;

  beforeEach(() => {
    control = temp();
    scratch = join(temp(), 'plugin-data', 'codex');
    mkdirSync(scratch, { recursive: true });
    process.env.FAKE_USAGE_DIR = control;
    now = new Date('2026-10-03T17:00:00.000Z');
  });
  afterEach(() => {
    for (const s of sources.splice(0)) s.stop?.();
    if (saved === undefined) delete process.env.FAKE_USAGE_DIR; else process.env.FAKE_USAGE_DIR = saved;
  });

  const ctx = () => ({ clock: { now: () => now }, logger: { info() {}, warn() {} }, dataDir: scratch, scratchDir: scratch, instanceName: 'codex', env: () => undefined });
  async function create(raw: Record<string, unknown> = {}): Promise<UsageSource> {
    const p = parseOptions(commandUsage, { command: [BIN, '--json'], executors: ['herdr-codex'], ...raw });
    if (!p.ok) throw new Error(p.error);
    const s = await commandUsage.create(ctx(), p.options as never);
    sources.push(s);
    return s;
  }
  const settled = (s: UsageSource) => waitFor(() => (s.state!().problem !== 'not read yet' ? true : undefined), { what: 'the first read' });

  it('is a usage source; `command` is required and command-bearing; executors name the jobs it budgets, absent = every job', () => {
    expect(commandUsage).toMatchObject({ id: 'command-usage', role: 'usage-source' });
    expect(parseOptions(commandUsage, {}).ok).toBe(false);
    expect(parseOptions(commandUsage, { command: [] }).ok).toBe(false);
    expect(parseOptions(commandUsage, { command: ['usage'] })).toEqual({ ok: true, options: { command: ['usage'], intervalSeconds: 600 } });
    expect(parseOptions(commandUsage, { command: ['usage'], executors: [] }).ok).toBe(false);
    const schema = optionsJsonSchema(commandUsage) as { properties: Record<string, { commandBearing?: boolean }> };
    expect(schema.properties.command!.commandBearing).toBe(true);
    expect(schema.properties.executors!.commandBearing).toBeUndefined();
  });

  it('detection is `which` of the command only: never a run', async () => {
    expect(await commandUsage.detect(fakeKit(), { command: ['codex-usage'], intervalSeconds: 600 })).toMatchObject({ status: 'available' });
    expect(await commandUsage.detect(fakeKit({ which: async () => undefined }), { command: ['codex-usage'], intervalSeconds: 600 }))
      .toEqual({ status: 'unavailable', reason: 'not found: codex-usage' });
  });

  it('its readings as the command prints them, named after the instance, budgeting the executors it names; its account in state', async () => {
    const s = await create();
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings' });
    const at = now.toISOString();
    expect(readings).toEqual([
      { source: 'codex', window: 'session', used: 40, limit: 100, unit: '%', resetsAt: '2026-10-03T18:00:00.000Z', executors: ['herdr-codex'], at },
    ]);
    await waitFor(() => s.state!().account, { what: 'the account' });
    expect(s.state!()).toEqual({ refreshedAt: at, account: { service: 'codex', identity: 'user@example.com', detail: { plan: 'pro' } } });
    const calls = readFileSync(join(control, 'calls.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(calls[0]).toEqual({ argv: ['--json'], cwd: join(scratch, 'probe') });
  });

  it('without executors a reading budgets every job; an informational reading stays informational', async () => {
    writeFileSync(join(control, 'out.json'), JSON.stringify({ readings: [{ used: 3, limit: 10, unit: 'jobs', informational: true }] }));
    const s = await create({ executors: undefined });
    const readings = await waitFor(async () => { const r = await s.poll(); return r.length ? r : undefined; }, { what: 'readings' });
    expect(readings).toEqual([{ source: 'codex', used: 3, limit: 10, unit: 'jobs', informational: true, at: now.toISOString() }]);
    expect(s.state!().account).toBeUndefined();
  });

  it('a failing command or output not of the shape: no readings, the reason in state', async () => {
    writeFileSync(join(control, 'exit'), '3');
    const s = await create();
    await settled(s);
    expect(await s.poll()).toEqual([]);
    expect(s.state!().problem).toMatch(/^usage command failed: exited 3/);

    writeFileSync(join(control, 'exit'), '0');
    writeFileSync(join(control, 'out.json'), JSON.stringify({ readings: [{ used: 'lots' }] }));
    const t = await create();
    await settled(t);
    expect(await t.poll()).toEqual([]);
    expect(t.state!().problem).toMatch(/^usage command output: /);
    expect(existsSync(join(scratch, 'probe'))).toBe(true);
  });
});
