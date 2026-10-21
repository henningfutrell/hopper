// Device grant requests (issue #892, design.md "Grants by device approval"): an agent asks for a grant and gets a device
// code and a short user code; a person enters the user code in the UI and approves or denies; the agent polls with its
// device code and takes the approval once. Kept in memory only, ten minutes at most. Only the clock is the test's.
import { beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_GRANT } from '../../src/domain/types.ts';
import { createDeviceGrants, type DeviceGrants } from '../../src/http/ui/device-grants.ts';
import { fixedClock } from '../store/helpers.ts';

const MINUTE = 60_000;
const clock = fixedClock();
let start: number;
const at = (ms: number) => clock.set(new Date(start + ms).toISOString());
let requests: DeviceGrants<string>;

beforeEach(() => {
  start = Date.parse('2026-10-16T10:00:00.000Z');
  at(0);
  requests = createDeviceGrants<string>({ clock });
});

const ask = { label: 'Grok Bot', holder: 'grok-bot', preset: 'read-only' };

describe('device grant requests (issue #892)', () => {
  it('a request answers a device code, a user code and where to enter it; the person finds it by its user code', () => {
    const r = requests.start(ask, 'caller-1');
    if (!r.ok) throw new Error(r.error);
    expect(r.value).toMatchObject({
      deviceCode: expect.stringMatching(/^hopper_dc_[0-9a-f]{64}$/), userCode: expect.stringMatching(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/),
      verificationPath: '/#users-access/api-tokens', interval: DEVICE_GRANT.intervalS, expiresAt: new Date(start + DEVICE_GRANT.minutes * MINUTE).toISOString(),
    });
    expect(r.value.verificationPathComplete).toBe(`/#users-access/api-tokens/${r.value.userCode}`);
    const seen = requests.find(r.value.userCode.toLowerCase().replace('-', ' '));
    expect(seen).toEqual({ userCode: r.value.userCode, ask, from: 'caller-1', createdAt: new Date(start).toISOString(), expiresAt: r.value.expiresAt });
    expect(JSON.stringify(seen)).not.toContain(r.value.deviceCode);
    expect(requests.find('BCDF-GHJK')).toBeUndefined();
  });

  it('the agent waits until a person approves; it takes the approval once, and the request is gone', () => {
    const r = requests.start(ask, 'caller-1');
    if (!r.ok) throw new Error(r.error);
    expect(requests.take(r.value.deviceCode)).toEqual({ state: 'waiting', interval: DEVICE_GRANT.intervalS, expiresAt: r.value.expiresAt });
    expect(requests.approve(r.value.userCode, 'approved by ada')).toBe(true);
    expect(requests.approve(r.value.userCode, 'again')).toBe(false);
    expect(requests.take(r.value.deviceCode)).toEqual({ state: 'approved', ask, approval: 'approved by ada' });
    expect(requests.take(r.value.deviceCode)).toBeUndefined();
    expect(requests.find(r.value.userCode)).toBeUndefined();
  });

  it('a denied request tells the agent once, and is gone', () => {
    const r = requests.start(ask, 'caller-1');
    if (!r.ok) throw new Error(r.error);
    expect(requests.deny(r.value.userCode)).toBe(true);
    expect(requests.find(r.value.userCode)).toBeUndefined();
    expect(requests.approve(r.value.userCode, 'late')).toBe(false);
    expect(requests.take(r.value.deviceCode)).toEqual({ state: 'denied' });
    expect(requests.take(r.value.deviceCode)).toBeUndefined();
  });

  it('a request ends after ten minutes, approved or not', () => {
    const waiting = requests.start(ask, 'caller-1');
    const approved = requests.start(ask, 'caller-2');
    if (!waiting.ok || !approved.ok) throw new Error('no request');
    requests.approve(approved.value.userCode, 'ada');
    at(DEVICE_GRANT.minutes * MINUTE);
    expect(requests.find(waiting.value.userCode)).toBeUndefined();
    expect(requests.take(waiting.value.deviceCode)).toBeUndefined();
    expect(requests.take(approved.value.deviceCode)).toBeUndefined();
  });

  it('a request bound to a key (issue #892, sender binding) answers only a poll that proves it; the request stands', () => {
    const jkt = 'k'.repeat(43);
    const r = requests.start({ ...ask, jkt }, 'caller-1');
    if (!r.ok) throw new Error(r.error);
    requests.approve(r.value.userCode, 'ada');
    expect(requests.take(r.value.deviceCode)).toEqual({ state: 'wrong-key' });
    expect(requests.take(r.value.deviceCode, 'x'.repeat(43))).toEqual({ state: 'wrong-key' });
    expect(requests.take(r.value.deviceCode, jkt)).toMatchObject({ state: 'approved', approval: 'ada' });
    expect(requests.take(r.value.deviceCode, jkt)).toBeUndefined();
  });

  it('an unknown device code is no request', () => {
    expect(requests.take(`hopper_dc_${'0'.repeat(64)}`)).toBeUndefined();
  });

  it('at most fifty wait at once; one that ends makes room', () => {
    for (let i = 0; i < DEVICE_GRANT.most; i++) expect(requests.start(ask, `caller-${i}`).ok).toBe(true);
    expect(requests.start(ask, 'one-more')).toEqual({ ok: false, error: expect.stringContaining('too many') });
    at(DEVICE_GRANT.minutes * MINUTE);
    expect(requests.start(ask, 'one-more').ok).toBe(true);
  });
});
