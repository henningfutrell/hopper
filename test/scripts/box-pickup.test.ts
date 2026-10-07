// The pickup protocol for agent boxes (issue #319, design.md "Pickups on agent boxes"): an operator-led
// session on a box reports what it picked up and how it stands in a pickup record there, and the hopper
// side reads the records over ssh and turns what changed into timeline lines. The record and its
// transitions (scripts/agent-box/pickup.ts), the box's CLI against a throwaway pickup dir, and the
// reader's diff (scripts/box-pickups.ts). A real box is verified by hand (design.md).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPickup, parsePickupLines, pickupFile, type PickupRecord } from '../../scripts/agent-box/pickup.ts';
import { pickupTimeline, type Seen } from '../../scripts/box-pickups.ts';

const ISSUE = 'https://github.com/owner/sandbox/issues/7';
const T0 = '2026-10-06T10:00:00.000Z';
const T1 = '2026-10-06T10:01:00.000Z';
const T2 = '2026-10-06T10:02:00.000Z';
const CLI = join(import.meta.dirname, '..', '..', 'scripts', 'agent-box', 'pickup.ts');

describe('a pickup record', () => {
  it('is named after its issue, one file per issue', () => {
    expect(pickupFile(ISSUE)).toBe('owner_sandbox_7.json');
    expect(() => pickupFile('https://example.com/x')).toThrow(/not a GitHub issue url/);
  });

  it('starts with a pickup, operator-led, and keeps every state change in its history', () => {
    const picked = applyPickup(undefined, { kind: 'pickup', issue: ISSUE, workTree: '/home/agent/sandbox' }, T0);
    expect(picked).toEqual({
      v: 1, issue: ISSUE, mode: 'operator-led', state: 'picked-up', pickedUpAt: T0, updatedAt: T0,
      workTree: '/home/agent/sandbox', history: [{ seq: 1, state: 'picked-up', at: T0 }],
    });
    const working = applyPickup(picked, { kind: 'status', state: 'working', note: 'reading the code' }, T1);
    const pr = applyPickup(working, { kind: 'status', state: 'pull-request', pullRequest: 'https://github.com/owner/sandbox/pull/8' }, T2);
    expect(pr.state).toBe('pull-request');
    expect(pr.pullRequest).toBe('https://github.com/owner/sandbox/pull/8');
    expect(pr.history.map((h) => [h.seq, h.state])).toEqual([[1, 'picked-up'], [2, 'working'], [3, 'pull-request']]);
    expect(pr.history[1]!.note).toBe('reading the code');
  });

  it('a heartbeat moves updatedAt only', () => {
    const picked = applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0);
    const beat = applyPickup(picked, { kind: 'beat' }, T1);
    expect(beat).toEqual({ ...picked, updatedAt: T1 });
  });

  it('refuses a status or a heartbeat with nothing picked up, and after the pickup ended', () => {
    expect(() => applyPickup(undefined, { kind: 'status', state: 'working' }, T0)).toThrow(/nothing picked up/);
    const released = applyPickup(applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0), { kind: 'status', state: 'released' }, T1);
    expect(() => applyPickup(released, { kind: 'status', state: 'working' }, T2)).toThrow(/ended \(released\): pick it up again/);
    expect(() => applyPickup(released, { kind: 'beat' }, T2)).toThrow(/ended/);
  });

  it('refuses a second pickup of an issue still picked up, and takes one again after it ended', () => {
    const picked = applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0);
    expect(() => applyPickup(picked, { kind: 'pickup', issue: ISSUE }, T1)).toThrow(/already picked up/);
    const finished = applyPickup(picked, { kind: 'status', state: 'finished' }, T1);
    const again = applyPickup(finished, { kind: 'pickup', issue: ISSUE }, T2);
    expect(again.state).toBe('picked-up');
    expect(again.pickedUpAt).toBe(T2);
    expect(again.history.map((h) => h.seq)).toEqual([1, 2, 3]);
  });

  it('a pull-request state names its pull request', () => {
    const picked = applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0);
    expect(() => applyPickup(picked, { kind: 'status', state: 'pull-request' }, T1)).toThrow(/names its pull request/);
  });

  it('keeps the last 50 history entries, their seq unbroken', () => {
    let r = applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0);
    for (let i = 0; i < 60; i++) r = applyPickup(r, { kind: 'status', state: i % 2 ? 'working' : 'waiting' }, T1);
    expect(r.history).toHaveLength(50);
    expect(r.history[0]!.seq).toBe(12);
    expect(r.history.at(-1)!.seq).toBe(61);
  });

  it('reads the list the box answers, one record per line, and names a line it cannot read', () => {
    const r = applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0);
    const { records, problems } = parsePickupLines(`${JSON.stringify(r)}\nnot json\n{"v":2}\n\n`);
    expect(records).toEqual([r]);
    expect(problems).toEqual(['line 2: not JSON', 'line 3: not a pickup record v1']);
  });
});

describe('the box CLI, hopper-pickup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pickups-'));
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOPPER_PICKUP_DIR: dir } });

  it('picks up, reports, lists and releases, each change one file in the pickup dir', () => {
    expect(run('pickup', ISSUE, '--work-tree', '/home/agent/sandbox').status).toBe(0);
    expect(run('status', ISSUE, 'working', '--note', 'on it').status).toBe(0);
    expect(run('beat', ISSUE).status).toBe(0);
    expect(readdirSync(dir)).toEqual(['owner_sandbox_7.json']);
    const list = run('list');
    expect(list.status).toBe(0);
    const { records, problems } = parsePickupLines(list.stdout);
    expect(problems).toEqual([]);
    expect(records.map((r) => r.state)).toEqual(['working']);
    expect(run('status', ISSUE, 'released').status).toBe(0);
  });

  it('says why it refuses, exit 1; usage, exit 2', () => {
    const r = run('status', 'https://github.com/owner/sandbox/issues/9', 'working');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/hopper-pickup: nothing picked up for https:\/\/github.com\/owner\/sandbox\/issues\/9/);
    expect(run('status', ISSUE, 'sleeping').status).toBe(2);
    expect(run().status).toBe(2);
  });
});

describe('the reader: what changed on the boxes, as timeline lines', () => {
  const picked = applyPickup(undefined, { kind: 'pickup', issue: ISSUE }, T0);
  const working = applyPickup(picked, { kind: 'status', state: 'working', note: 'on it' }, T1);
  const box = (records: PickupRecord[]) => ({ box: 'hopper-box-claude', records });

  it('a first read shows every history entry; a second read shows only the new ones', () => {
    const seen: Seen = new Map();
    const first = pickupTimeline(seen, [box([working])], Date.parse(T1), 120_000);
    expect(first.map((l) => l.text)).toEqual([
      `hopper-box-claude ${ISSUE} picked up (operator-led)`,
      `hopper-box-claude ${ISSUE} working: on it`,
    ]);
    expect(first[0]!.at).toBe(T0);
    expect(pickupTimeline(seen, [box([working])], Date.parse(T1), 120_000)).toEqual([]);
    const pr = applyPickup(working, { kind: 'status', state: 'pull-request', pullRequest: 'https://github.com/owner/sandbox/pull/8' }, T2);
    expect(pickupTimeline(seen, [box([pr])], Date.parse(T2), 120_000).map((l) => l.text))
      .toEqual([`hopper-box-claude ${ISSUE} pull request https://github.com/owner/sandbox/pull/8`]);
  });

  it('a pickup not heard from past the stale time is stale once, and heard from again once it beats', () => {
    const seen: Seen = new Map();
    pickupTimeline(seen, [box([working])], Date.parse(T1), 120_000);
    const late = Date.parse(T1) + 121_000;
    expect(pickupTimeline(seen, [box([working])], late, 120_000).map((l) => l.text))
      .toEqual([`hopper-box-claude ${ISSUE} stale: not heard from since ${T1}`]);
    expect(pickupTimeline(seen, [box([working])], late + 10_000, 120_000)).toEqual([]);
    const beat = applyPickup(working, { kind: 'beat' }, new Date(late + 20_000).toISOString());
    expect(pickupTimeline(seen, [box([beat])], late + 20_000, 120_000).map((l) => l.text))
      .toEqual([`hopper-box-claude ${ISSUE} heard from again`]);
  });

  it('an ended pickup is never stale', () => {
    const seen: Seen = new Map();
    const finished = applyPickup(working, { kind: 'status', state: 'finished' }, T2);
    pickupTimeline(seen, [box([finished])], Date.parse(T2), 120_000);
    expect(pickupTimeline(seen, [box([finished])], Date.parse(T2) + 999_000, 120_000)).toEqual([]);
  });

  it('a box that cannot be read says so once, and once more when it answers again', () => {
    const seen: Seen = new Map();
    expect(pickupTimeline(seen, [{ box: 'hopper-box-codex', error: 'ssh: connect refused' }], 0, 120_000).map((l) => l.text))
      .toEqual(['hopper-box-codex unreadable: ssh: connect refused']);
    expect(pickupTimeline(seen, [{ box: 'hopper-box-codex', error: 'ssh: connect refused' }], 1, 120_000)).toEqual([]);
    expect(pickupTimeline(seen, [{ box: 'hopper-box-codex', records: [] }], 2, 120_000).map((l) => l.text))
      .toEqual(['hopper-box-codex readable again']);
  });
});
