// One live sign-in per machine and tool (issue #2898, design.md "Tool sign-in"): a sign-in asked while one still waits for its code
// is that one; one that cannot go on is superseded, its card gone and its code refused with a clear message; two asks at the same
// moment, on one host or two, open one.
//
// Feature: at most one live sign-in per machine and tool
//   Scenario: asked again while one waits
//     Given a sign-in that waits for its code on a machine
//     When a sign-in is asked for the same machine
//     Then the answer is the same login, and no run starts
//   Scenario: two asks at one moment
//     Given no sign-in on a machine
//     When two sign-ins are asked at the same moment, on one host or on two
//     Then one login waits, and one run goes on
//   Scenario: the sign-in before cannot go on
//     Given a sign-in that expired, is about to, names another account, or runs on another host
//     When a sign-in is asked for the same machine
//     Then the new one waits, and the one before says it was replaced and points at it
//     And a code given to the one before is refused with "this sign-in was replaced; use the current card"
//   Scenario: other machines
//     Given a sign-in that waits on a machine
//     When a sign-in is asked for another machine
//     Then both wait
import { afterEach, describe, expect, it } from 'vitest';
import type { UsageSource } from '../../src/domain/ports.ts';
import { ADMIN_ID, type Login, type ToolSignIn } from '../../src/domain/types.ts';
import { createLogins } from '../../src/logins/service.ts';
import { createSignIns, type SignInStart } from '../../src/logins/sign-ins.ts';
import { openInstanceStore } from '../../src/store/index.ts';
import { installFromBefore, testDatabaseUrl } from '../support/database.ts';

let at = Date.parse('2026-11-02T12:00:00.000Z');
const clock = { now: () => new Date(at) };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); at = Date.parse('2026-11-02T12:00:00.000Z'); });

type FakeRun = ToolSignIn & { cancelled: boolean; pasted: string[] };

/** A usage source that reads the tool on `machineId`, and the runs it started. */
function sourceOn(machineId: string, name = `claude-${machineId}`) {
  const runs: FakeRun[] = [];
  const source: UsageSource = {
    name, poll: async () => [],
    signInTarget: async () => ({ machineId, tool: 'claude' }),
    signIn: async () => {
      await new Promise((r) => setTimeout(r, 5));
      const run: FakeRun = {
        machineId, tool: 'claude', url: `https://claude.ai/oauth/authorize?run=${runs.length}`, cancelled: false, pasted: [],
        paste: async (code) => { run.pasted.push(code); return { ok: true }; },
        cancel: () => { run.cancelled = true; },
      };
      runs.push(run);
      return run;
    },
  };
  return { source, runs };
}

function host(url: string, sources: UsageSource[], owner: string, live: () => boolean) {
  const instance = openInstanceStore({ url, clock });
  const store = instance.userStore(instance.users.get(ADMIN_ID)!);
  const logins = createLogins({ store, clock });
  const signIns = createSignIns({ logins, sources: () => sources, clock, sweepMs: 3_600_000, hosts: { owner, live } });
  cleanups.push(() => { signIns.stop(); store.close(); instance.close(); });
  return { store, logins, signIns };
}

const oneHost = (sources: UsageSource[]) => host(installFromBefore(testDatabaseUrl()), sources, 'host-a', () => true);

const started = (r: SignInStart): Login => {
  if (!r.ok) throw new Error(r.message);
  return r.login;
};

const waiting = (h: { logins: ReturnType<typeof createLogins> }): Login[] => h.logins.list({ status: ['pending'] });

describe('one live sign-in per machine and tool', () => {
  it('answers the sign-in that waits, and starts no second run', async () => {
    const { source, runs } = sourceOn('box');
    const h = oneHost([source]);
    const first = started(await h.signIns.start(source.name));
    const again = started(await h.signIns.start(source.name));
    expect(again.id).toBe(first.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cancelled).toBe(false);
    expect(waiting(h)).toHaveLength(1);
    expect(h.logins.view(again, true).verificationUrl).toBe(runs[0]!.url);
    expect(h.store.logins.get(first.id)!.status).toBe('pending');
    expect((await h.signIns.paste(first.id, 'good-code')).ok).toBe(true);
    expect(runs[0]!.pasted).toEqual(['good-code']);
  });

  it('opens one for two asks at the same moment', async () => {
    const { source, runs } = sourceOn('box');
    const h = oneHost([source]);
    const [a, b] = await Promise.all([h.signIns.start(source.name), h.signIns.start(source.name)]);
    expect(started(a).id).toBe(started(b).id);
    expect(runs).toHaveLength(1);
    expect(waiting(h)).toHaveLength(1);
  });

  it('opens one when two hosts ask at the same moment: the second host stops its run', async () => {
    const url = installFromBefore(testDatabaseUrl());
    const onA = sourceOn('box', 'claude'), onB = sourceOn('box', 'claude');
    const a = host(url, [onA.source], 'host-a', () => true), b = host(url, [onB.source], 'host-b', () => true);
    const [fromA, fromB] = await Promise.all([a.signIns.start('claude'), b.signIns.start('claude')]);
    const ids = new Set([started(fromA).id, started(fromB).id]);
    const live = waiting(a);
    expect(live).toHaveLength(1);
    expect(ids.has(live[0]!.id)).toBe(true);
    a.signIns.sweep();
    b.signIns.sweep();
    const runs = [...onA.runs, ...onB.runs];
    expect(runs.filter((r) => !r.cancelled)).toHaveLength(1);
  });

  it('answers the other host\'s login when the database refuses this one: nothing is replaced, nothing else waits', async () => {
    const url = installFromBefore(testDatabaseUrl());
    const onA = sourceOn('box', 'claude');
    const a = host(url, [onA.source], 'host-a', () => true), b = host(url, [], 'host-b', () => true);
    const first = started(await a.signIns.start('claude'));
    const report = { kind: 'paste_code' as const, tool: 'claude', verificationUrl: 'https://claude.ai/oauth/authorize?run=b', expiresAt: first.expiresAt };
    const answer = b.logins.openSignIn(report, { machineId: 'box', run: 'sign-in', renewable: false }, []);
    expect(answer).toMatchObject({ opened: false, login: { id: first.id } });
    expect(waiting(a).map((l) => l.id)).toEqual([first.id]);
  });

  it('refuses a second waiting sign-in in the database itself', async () => {
    const { source } = sourceOn('box');
    const h = oneHost([source]);
    const first = started(await h.signIns.start(source.name));
    const input = { kind: 'paste_code' as const, tool: 'claude', expiresAt: first.expiresAt, machineId: 'box', run: 'sign-in', renewable: false };
    expect(h.store.logins.createSignIn(input)).toBeUndefined();
    expect(h.store.logins.createSignIn({ ...input, tool: 'other' })).toBeDefined();
    expect(h.store.logins.createSignIn({ ...input, machineId: 'other' })).toBeDefined();
  });

  it('supersedes one that expired: its card is replaced, and its code refused with a clear message', async () => {
    const { source, runs } = sourceOn('box');
    const h = oneHost([source]);
    const first = started(await h.signIns.start(source.name));
    at += 16 * 60_000;
    h.logins.sweep();
    expect(h.store.logins.get(first.id)!.status).toBe('expired');
    const second = started(await h.signIns.start(source.name));
    expect(second.id).not.toBe(first.id);
    expect(runs[0]!.cancelled).toBe(true);
    expect(h.store.logins.get(first.id)).toMatchObject({ status: 'cancelled', supersededBy: second.id });
    expect(waiting(h).map((l) => l.id)).toEqual([second.id]);
    expect(h.store.events.recent(1, ['auth.cancelled'])[0]?.data).toMatchObject({ loginId: first.id, by: 'superseded', supersededBy: second.id });

    expect(await h.signIns.paste(first.id, 'good-code')).toEqual({ ok: false, reason: 'ended', message: 'this sign-in was replaced; use the current card' });
    expect(runs[1]!.pasted).toEqual([]);
    expect((await h.signIns.paste(second.id, 'good-code')).ok).toBe(true);
  });

  it('supersedes one about to expire, and one of another account', async () => {
    const { source, runs } = sourceOn('box');
    const h = oneHost([source]);
    const first = started(await h.signIns.start(source.name));
    at += 14 * 60_000;
    const second = started(await h.signIns.start(source.name));
    expect(second.id).not.toBe(first.id);
    expect(h.store.logins.get(first.id)).toMatchObject({ status: 'cancelled', supersededBy: second.id });

    expect(started(await h.signIns.start(source.name, { email: 'a@example.com' })).id).not.toBe(second.id);
    const third = waiting(h)[0]!;
    expect(started(await h.signIns.start(source.name, { email: 'a@example.com' })).id).toBe(third.id);
    expect(started(await h.signIns.start(source.name)).id).toBe(third.id);
    const fourth = started(await h.signIns.start(source.name, { email: 'b@example.com' }));
    expect(fourth.id).not.toBe(third.id);
    expect(runs.filter((r) => !r.cancelled)).toHaveLength(1);
    expect(waiting(h)).toHaveLength(1);
  });

  it('supersedes one another host runs: this host cannot show its page or take its code', async () => {
    const url = installFromBefore(testDatabaseUrl());
    const onA = sourceOn('box', 'claude'), onB = sourceOn('box', 'claude');
    const a = host(url, [onA.source], 'host-a', () => true), b = host(url, [onB.source], 'host-b', () => true);
    const first = started(await a.signIns.start('claude'));

    const onOther = await b.signIns.paste(first.id, 'good-code');
    expect(onOther).toMatchObject({ ok: false, reason: 'ended' });
    expect(onOther.ok ? '' : onOther.message).toMatch(/start it again/);
    expect(onOther.ok ? '' : onOther.message).not.toMatch(/waits for its code/);

    const second = started(await b.signIns.start('claude'));
    expect(second.id).not.toBe(first.id);
    expect(a.store.logins.get(first.id)).toMatchObject({ status: 'cancelled', supersededBy: second.id });
    a.signIns.sweep();
    expect(onA.runs[0]!.cancelled).toBe(true);
    expect(onB.runs[0]!.cancelled).toBe(false);
    expect(waiting(a).map((l) => l.id)).toEqual([second.id]);
  });

  it('answers the sign-in that waits while its code is with the tool', async () => {
    const { source, runs } = sourceOn('box');
    const h = oneHost([source]);
    const first = started(await h.signIns.start(source.name));
    let end: (r: { ok: true }) => void = () => {};
    runs[0]!.paste = () => new Promise((r) => { end = r; });
    const pasting = h.signIns.paste(first.id, 'good-code');
    expect(started(await h.signIns.start(source.name)).id).toBe(first.id);
    const twice = await h.signIns.paste(first.id, 'good-code');
    expect(twice.ok ? '' : twice.message).toBe('this sign-in has its code already: wait for its answer');
    end({ ok: true });
    expect((await pasting).ok).toBe(true);
    expect(runs).toHaveLength(1);
  });

  it('says what happened to an ended sign-in, never that it is not one', async () => {
    const { source } = sourceOn('box');
    const h = oneHost([source]);
    const first = started(await h.signIns.start(source.name));
    h.logins.cancel(first.id);
    h.signIns.sweep();
    const r = await h.signIns.paste(first.id, 'good-code');
    expect(r).toEqual({ ok: false, reason: 'ended', message: 'this sign-in is cancelled: start it again' });
  });

  it('holds for the Claude sign-in for pods: the same account is the one that waits, another supersedes it', async () => {
    const instance = openInstanceStore({ url: installFromBefore(testDatabaseUrl()), clock });
    const store = instance.userStore(instance.users.get(ADMIN_ID)!);
    const logins = createLogins({ store, clock });
    let starts = 0;
    const setupToken = { start: async () => { starts += 1; return { url: `https://claude.ai/oauth/authorize?run=${starts}`, paste: async () => ({ ok: true as const }), cancel: () => {} }; } };
    const signIns = createSignIns({ logins, sources: () => [], clock, sweepMs: 3_600_000, setupToken });
    cleanups.push(() => { signIns.stop(); store.close(); instance.close(); });
    const first = started(await signIns.startSetupToken({ account: 'a@example.com', by: 'admin' }));
    expect(started(await signIns.startSetupToken({ account: 'a@example.com', by: 'admin' })).id).toBe(first.id);
    expect(starts).toBe(1);
    const other = started(await signIns.startSetupToken({ account: 'b@example.com', by: 'admin' }));
    expect(other.id).not.toBe(first.id);
    expect(store.logins.get(first.id)).toMatchObject({ status: 'cancelled', supersededBy: other.id });
    expect(logins.view(other, true).account).toBe('b@example.com');
  });

  it('keeps the sign-ins of two machines apart', async () => {
    const one = sourceOn('box'), other = sourceOn('other-box');
    const h = oneHost([one.source, other.source]);
    const a = started(await h.signIns.start(one.source.name));
    const b = started(await h.signIns.start(other.source.name));
    expect(a.id).not.toBe(b.id);
    expect(one.runs[0]!.cancelled).toBe(false);
    expect(waiting(h)).toHaveLength(2);
  });

  it('with a source that names no machine first, keeps the one that waits and stops the new run', async () => {
    const { source, runs } = sourceOn('box');
    const { signInTarget: _named, ...unnamed } = source;
    const h = oneHost([unnamed]);
    const first = started(await h.signIns.start(source.name));
    const again = started(await h.signIns.start(source.name));
    expect(again.id).toBe(first.id);
    expect(runs[0]!.cancelled).toBe(false);
    expect(runs[1]!.cancelled).toBe(true);
    expect(waiting(h)).toHaveLength(1);
  });
});
