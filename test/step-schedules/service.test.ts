// Step schedules (issue #2716, src/step-schedules/service.ts): a due schedule runs its step once per due time, never two
// runs at once, and not again after a restart; a run gets the folder of its repository at its paths, runs its script in a
// new sandbox of its template, and the template's vault secrets only after a person's grant. Over the real user database;
// the GitHub read, the vault and the need box are doubles at their seams, and a test runs each saga's step itself.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { UserStore } from '../../src/domain/ports.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import type { NeedBox, NeedBoxResult } from '../../src/sandbox/need-box.ts';
import { STEP_INTERRUPTED } from '../../src/sandbox/need-steps.ts';
import type { ScheduleFolder } from '../../src/step-schedules/github.ts';
import { createStepSchedules, NO_MINT_ON_SCHEDULE, type StepSchedulesOptions } from '../../src/step-schedules/service.ts';
import { openUserStore } from '../../src/store/user-store.ts';
import { testDatabaseUrl } from '../support/database.ts';

const SECRET = 'bucket-key-6c1f0e9a';
const READY = {
  name: 'backup', image: 'ghcr.io/example/box:backup', profiles: [], egress: ['s3.example:443'], agentCredential: 'claude-token',
  secrets: ['BUCKET_KEY', 'claude-token'], gives: ['BUCKET_KEY', 'claude-token'],
  approval: { by: 'a person' }, pending: { secrets: [], image: false, egress: [], profiles: [] },
} as unknown as TemplateView;
const FIELDS = { name: 'nightly-backup', template: 'backup', repo: 'acme/ops', input: 'workflows/web-app-development/phrase-drill/offsite-backup', script: 'workflows/web-app-development/phrase-drill/offsite-backup/step.sh', daily: '02:00', timeoutSeconds: 1800 };
const FOLDER: ScheduleFolder = { commit: 'c0ffee', files: [
  { path: FIELDS.script, data: Buffer.from('#!/bin/sh\necho backup\n'), executable: true },
  { path: `${FIELDS.input}/conf/a-file-name-that-is-long-enough-to-push-the-whole-path-past-one-hundred-bytes.txt`, data: Buffer.from([0, 1, 2, 255]), executable: false },
] };

const stores: UserStore[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The names and bytes of a tar's files (ustar, the prefix too). */
function untar(tar: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const text = (from: number, len: number) => tar.subarray(at + from, at + from + len).toString('ascii').replace(/\0.*$/s, '');
    const size = parseInt(text(124, 12), 8);
    const prefix = text(345, 155);
    files.set(prefix ? `${prefix}/${text(0, 100)}` : text(0, 100), tar.subarray(at + 512, at + 512 + size));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** A hopper's step schedules over the database at `url`; its clock `clock`. */
function hopper(url: string, clock: { now(): Date }, o: Partial<StepSchedulesOptions> & { result?: NeedBoxResult; started?: Set<string> } = {}) {
  const store = openUserStore({ url, clock, idGen: randomUUID });
  stores.push(store);
  const dir = mkdtempSync(join(tmpdir(), 'step-schedules-'));
  dirs.push(dir);
  const events: NewEvent[] = [];
  const begun: string[] = [];
  const boxes: { box: Omit<NeedBox, 'userId' | 'instanceId' | 'network'>; inputs: Map<string, Buffer>; secrets: Record<string, string> | undefined; run: { jobId: string; step: string } }[] = [];
  const asked: unknown[] = [];
  // The sandbox runs ledger the sandbox module writes, shared by every hopper on the database.
  const started = o.started ?? new Set<string>();
  const s = createStepSchedules({
    userId: 'admin', repo: store.stepSchedules, templates: () => [READY], files: async () => FOLDER, dir, now: () => clock.now(),
    record: (e) => { events.push(e); }, log: () => {}, ran: (run) => started.has(run),
    secret: async (ask) => { asked.push(ask); return { value: SECRET }; },
    sagas: { begin: (run) => { begun.push(run); return `saga-${run}`; }, abort: () => true },
    run: async (box, io, run) => {
      started.add(run.step);
      // The secrets as the box got them: the hopper drops its copy once the run ends.
      boxes.push({ box, inputs: untar(readFileSync(box.files!.inputs!)), secrets: box.files?.secrets ? { ...box.files.secrets } : undefined, run });
      io.log(`using ${SECRET}\n`);
      return o.result ?? { exit: 0 };
    },
    ...o,
  });
  return { s, store, events, begun, boxes, asked, started };
}

const at = (iso: string) => {
  let t = new Date(iso);
  return { now: () => t, set: (v: string) => { t = new Date(v); } };
};

describe('a step schedule runs once per due time (issue #2716)', () => {
  it('a due schedule is claimed once, however often the hopper looks, and again at the next due time', async () => {
    const clock = at('2026-10-24T10:00:00Z');
    const h = hopper(testDatabaseUrl(), clock);
    expect('schedule' in h.s.save(FIELDS, 'Pat')).toBe(true);
    h.s.tick();
    expect(h.begun).toHaveLength(0); // today's 02:00 is before the save
    clock.set('2026-10-25T02:00:30Z');
    h.s.tick(); h.s.tick();
    expect(h.begun).toHaveLength(1);
    await h.s.execute(h.begun[0]!, new AbortController().signal);
    h.s.tick();
    expect(h.begun).toHaveLength(1);
    clock.set('2026-10-26T02:01:00Z');
    h.s.tick();
    expect(h.begun).toHaveLength(2);
    expect(h.s.runs(FIELDS.name)!.runs.map((r) => r.due)).toEqual(['2026-10-26T02:00:00.000Z', '2026-10-25T02:00:00.000Z']);
  });

  it('two hoppers on one database claim the due time once between them', () => {
    const url = testDatabaseUrl(), clock = at('2026-10-24T10:00:00Z');
    const a = hopper(url, clock), b = hopper(url, clock);
    a.s.save(FIELDS, 'Pat');
    clock.set('2026-10-25T02:00:30Z');
    a.s.tick(); b.s.tick();
    expect(a.begun.length + b.begun.length).toBe(1);
  });

  it('after a restart a due time that ran is not run again, and one the stop missed runs once', async () => {
    const url = testDatabaseUrl(), clock = at('2026-10-24T10:00:00Z');
    const before = hopper(url, clock);
    before.s.save(FIELDS, 'Pat');
    clock.set('2026-10-25T02:00:30Z');
    before.s.tick();
    await before.s.execute(before.begun[0]!, new AbortController().signal);
    // The hopper stops; another starts on the same database, later the same day: nothing to run.
    clock.set('2026-10-25T09:00:00Z');
    const after = hopper(url, clock);
    after.s.tick();
    expect(after.begun).toHaveLength(0);
    // It is down across three due times: the newest runs once when it starts again.
    clock.set('2026-10-28T12:00:00Z');
    const later = hopper(url, clock);
    later.s.tick(); later.s.tick();
    expect(later.begun).toHaveLength(1);
    expect(later.s.runs(FIELDS.name)!.runs[0]!.due).toBe('2026-10-28T02:00:00.000Z');
  });

  it('a run whose sandbox started on a hopper that stopped is not run again: it ends interrupted', async () => {
    const url = testDatabaseUrl(), clock = at('2026-10-24T10:00:00Z'), started = new Set<string>();
    const a = hopper(url, clock, { started });
    a.s.save(FIELDS, 'Pat');
    const { run } = a.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } };
    started.add(run.id); // its need box started, then the hopper stopped
    const b = hopper(url, clock, { started });
    await b.s.execute(run.id, new AbortController().signal);
    expect(b.boxes).toHaveLength(0);
    const ended = b.s.runs(FIELDS.name)!.runs[0]!;
    expect(ended).toMatchObject({ outcome: 'interrupted', exit: 125, problem: STEP_INTERRUPTED });
    expect(b.events.find((e) => e.type === 'step_schedule.run_failed')?.data).toMatchObject({ outcome: 'interrupted' });
  });

  it('a claim no saga took after a stop ends, so the schedule runs again', () => {
    const url = testDatabaseUrl(), clock = at('2026-10-24T10:00:00Z');
    const h = hopper(url, clock);
    h.s.save(FIELDS, 'Pat');
    h.store.stepSchedules.claim({ id: randomUUID(), schedule: FIELDS.name, due: '2026-10-24T09:00:00.000Z', trigger: 'now', box: 'b', startedAt: clock.now().toISOString() });
    expect(h.s.runNow(FIELDS.name, 'Pat')).toMatchObject({ status: 409 });
    clock.set('2026-10-24T10:02:00Z');
    h.s.tick();
    expect(h.s.runNow(FIELDS.name, 'Pat')).toHaveProperty('run');
  });

  it('never two runs at once: run now waits for the run that has not ended', async () => {
    const h = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'));
    h.s.save(FIELDS, 'Pat');
    const first = h.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } };
    expect(h.s.runNow(FIELDS.name, 'Pat')).toEqual({ status: 409, no: `a run of ${FIELDS.name} has not ended: it runs one at a time` });
    expect(h.s.remove(FIELDS.name, 'Pat')).toMatchObject({ status: 409 });
    await h.s.execute(first.run.id, new AbortController().signal);
    expect(h.s.runNow(FIELDS.name, 'Pat')).toHaveProperty('run');
  });
});

describe('a scheduled run (issue #2716)', () => {
  it('runs its script in a new sandbox of its template, its folder at its paths, the secrets only after the grant, masked', async () => {
    const h = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'));
    h.s.save(FIELDS, 'Pat');
    // No grant: the template gives a vault secret, so the run does not start.
    const first = h.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } };
    await h.s.execute(first.run.id, new AbortController().signal);
    expect(h.boxes).toHaveLength(0);
    expect(h.s.runs(FIELDS.name)!.runs[0]).toMatchObject({ outcome: 'failed', exit: 125 });
    expect(h.s.runs(FIELDS.name)!.runs[0]!.problem).toMatch(/has no vault grant.*hopper schedule grant nightly-backup/);
    expect(h.s.view().failed).toEqual([FIELDS.name]);

    h.s.grant(FIELDS.name, 'Pat');
    const second = h.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } };
    await h.s.execute(second.run.id, new AbortController().signal);
    const [{ box, inputs, secrets, run }] = h.boxes as [typeof h.boxes[number]];
    expect(box.env.HOPPER_STEP_COMMAND).toBe(`sh ./${FIELDS.script}`);
    expect(box.timeoutMs).toBe(1_800_000);
    expect(box.template).toMatchObject({ image: READY.image, egress: ['s3.example:443'] });
    expect([...inputs.keys()].sort()).toEqual(FOLDER.files.map((f) => f.path).sort());
    expect(inputs.get(FOLDER.files[1]!.path)).toEqual(FOLDER.files[1]!.data);
    // The template's secret, never its agent credential.
    expect(secrets).toEqual({ BUCKET_KEY: SECRET });
    expect(box.files!.secrets).toEqual({});
    expect(h.asked).toEqual([{ name: 'BUCKET_KEY', schedule: FIELDS.name, host: box.name, template: 'backup' }]);
    expect(run.jobId).toBe(`schedule:${FIELDS.name}`);
    const runs = h.s.runs(FIELDS.name)!.runs;
    expect(runs[0]).toMatchObject({ outcome: 'succeeded', exit: 0 });
    expect(runs[0]!.log).toContain('using ');
    expect(runs[0]!.log).not.toContain(SECRET);
    expect(h.s.view().failed).toEqual([]);
    expect(h.events.map((e) => e.type)).toEqual(expect.arrayContaining(['step_schedule.saved', 'step_schedule.granted', 'step_schedule.run_started', 'step_schedule.run_finished']));
  });

  it('a script that exits non-zero, or times out, is run_failed with its exit code', async () => {
    const h = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'), { result: { exit: 3 } });
    h.s.save(FIELDS, 'Pat'); h.s.grant(FIELDS.name, 'Pat');
    await h.s.execute((h.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } }).run.id, new AbortController().signal);
    expect(h.events.find((e) => e.type === 'step_schedule.run_failed')?.data).toMatchObject({ schedule: FIELDS.name, exit: 3, outcome: 'failed' });
    const t = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'), { result: { exit: 124, stopped: 'timed-out', problem: 'the step timed out' } });
    t.s.save(FIELDS, 'Pat'); t.s.grant(FIELDS.name, 'Pat');
    await t.s.execute((t.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } }).run.id, new AbortController().signal);
    expect(t.s.runs(FIELDS.name)!.runs[0]!.problem).toBe('timed out after 1800 s');
  });

  it('files GitHub does not give, or a script not in them, fail the run before any sandbox', async () => {
    const h = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'), { files: async () => ({ problem: 'no folder acme/ops/x at main' }) });
    h.s.save(FIELDS, 'Pat'); h.s.grant(FIELDS.name, 'Pat');
    await h.s.execute((h.s.runNow(FIELDS.name, 'Pat') as { run: { id: string } }).run.id, new AbortController().signal);
    expect(h.boxes).toHaveLength(0);
    expect(h.s.runs(FIELDS.name)!.runs[0]!.problem).toBe("the step's files: no folder acme/ops/x at main");
  });

  it('a save that changes what runs takes the grant back; a new time keeps it', () => {
    const h = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'));
    h.s.save(FIELDS, 'Pat'); h.s.grant(FIELDS.name, 'Pat');
    expect((h.s.save({ ...FIELDS, daily: '03:00' }, 'Pat') as { schedule: { grant?: unknown } }).schedule.grant).toBeDefined();
    expect((h.s.save({ ...FIELDS, repo: 'acme/other' }, 'Pat') as { schedule: { grant?: unknown } }).schedule.grant).toBeUndefined();
  });

  it('a template the vault mints credentials for, or no such template, takes no schedule', () => {
    const minting = { ...READY, profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: '123456789012/read' } }] } as unknown as TemplateView;
    const h = hopper(testDatabaseUrl(), at('2026-10-24T10:00:00Z'), { templates: () => [minting] });
    expect(h.s.save(FIELDS, 'Pat')).toEqual({ status: 409, no: NO_MINT_ON_SCHEDULE });
    expect(h.s.save({ ...FIELDS, template: 'other' }, 'Pat')).toMatchObject({ status: 409 });
  });
});
