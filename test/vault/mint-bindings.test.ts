// Issue #1371 (decision #1394): a sandbox's Kubernetes token is bound to a Secret of its own (`bindTo`), held for its
// sandbox, and unbound — the Secret deleted, so the token stops working — when the sandbox ends, whatever its outcome.
// A binding a hopper that stopped, or an unbind that failed, left is unbound by the reconcile pass. The vault's mint
// for a need step and the minting credential's service are doubles at their seams; the event log is in memory.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import type { MintBinding, MintTarget } from '../../src/domain/minting.ts';
import type { DomainEvent, EventType, NewEvent } from '../../src/domain/types.ts';
import { mintBindings, type UnbindFrom } from '../../src/vault/bindings.ts';
import type { MintFrom } from '../../src/vault/mint.ts';
import { needMinting } from '../../src/vault/need-mint.ts';

const NOW = new Date('2026-10-16T12:00:00Z');
const clock = { now: () => NOW };

function eventLog() {
  const all: DomainEvent[] = [];
  return {
    all,
    append(e: NewEvent): DomainEvent {
      const d = { ...e, seq: all.length + 1, id: `e${all.length + 1}`, schemaVersion: 1, at: e.at ?? NOW.toISOString() } as DomainEvent;
      all.push(d);
      return d;
    },
    between: (types: readonly EventType[], since: string) => all.filter((e) => types.includes(e.type) && e.at >= since),
  };
}

function unbinder(fail = new Set<string>()) {
  const unbound: MintBinding[] = [];
  const from: UnbindFrom = async (b) => {
    if (fail.has(b.secret)) return { refused: 'the Kubernetes API could not be reached' };
    unbound.push(b);
    return { ok: true };
  };
  return { unbound, from, fail };
}

const A: MintBinding = { credential: 'KUBE_LAB', namespace: 'lab', secret: 'hopper-mint-a' };
const B: MintBinding = { credential: 'KUBE_LAB', namespace: 'lab', secret: 'hopper-mint-b' };

describe('the bindings of a sandbox\'s tokens (issue #1371)', () => {
  it('a sandbox\'s release unbinds each token bound for it, and records each', async () => {
    const events = eventLog();
    const u = unbinder();
    const b = mintBindings({ events, clock, unbindFrom: u.from, logger: { warn: () => {} } });
    b.hold('hopper-need-kube-1', A, 'job-1');
    b.hold('hopper-need-kube-1', B, 'job-1');
    b.hold('hopper-need-kube-2', { ...A, secret: 'hopper-mint-other' }, 'job-2');
    await b.release('hopper-need-kube-1');
    expect(u.unbound).toEqual([A, B]);
    expect(events.all.map((e) => [e.type, e.jobId, e.data])).toEqual([
      ['vault.unbound', 'job-1', { box: 'hopper-need-kube-1', job: 'job-1', ...A }],
      ['vault.unbound', 'job-1', { box: 'hopper-need-kube-1', job: 'job-1', ...B }],
    ]);
    // A second release finds nothing: the sandbox holds no binding now.
    await b.release('hopper-need-kube-1');
    expect(u.unbound).toHaveLength(2);
  });

  it('a release whose unbind fails never rejects; the reconcile pass unbinds it once it can', async () => {
    const events = eventLog();
    const u = unbinder(new Set([A.secret]));
    const warned: string[] = [];
    const b = mintBindings({ events, clock, unbindFrom: u.from, logger: { warn: (l) => warned.push(l) } });
    events.append({ type: 'vault.minted', jobId: 'job-1', machineId: 'box-1', data: { machine: 'box-1', job: 'job-1', credential: A.credential, bound: { namespace: A.namespace, secret: A.secret } } });
    b.hold('box-1', A, 'job-1');
    await expect(b.release('box-1')).resolves.toBeUndefined();
    expect(warned.join('\n')).toMatch(/hopper-mint-a.*could not be reached/);
    u.fail.clear();
    await b.reconcile();
    expect(u.unbound).toEqual([A]);
    expect(events.all.filter((e) => e.type === 'vault.unbound')).toHaveLength(1);
  });

  it('after a restart, the reconcile pass unbinds each binding a minted event names and no unbound event ends', async () => {
    const events = eventLog();
    // What a hopper that stopped mid-step left: two need steps' mints and a check box's, one already unbound.
    events.append({ type: 'vault.minted', jobId: 'job-1', machineId: 'box-1', data: { machine: 'box-1', job: 'job-1', credential: A.credential, bound: { namespace: 'lab', secret: A.secret } } });
    events.append({ type: 'vault.minted', jobId: 'job-2', machineId: 'box-2', data: { machine: 'box-2', job: 'job-2', credential: B.credential, bound: { namespace: 'lab', secret: B.secret } } });
    events.append({ type: 'vault.check_minted', data: { check: 'check-1', credential: 'KUBE_LAB', bound: { namespace: 'web', secret: 'hopper-mint-c' } } });
    events.append({ type: 'vault.minted', jobId: 'job-3', machineId: 'box-3', data: { machine: 'box-3', job: 'job-3', credential: 'AWS', principal: 'x' } });
    events.append({ type: 'vault.unbound', jobId: 'job-2', data: { box: 'box-2', job: 'job-2', ...B } });
    const u = unbinder();
    const b = mintBindings({ events, clock, unbindFrom: u.from, logger: { warn: () => {} } });
    // A step that runs now holds its binding: the pass leaves it to the step.
    b.hold('box-4', { ...A, secret: 'hopper-mint-d' }, 'job-4');
    events.append({ type: 'vault.minted', jobId: 'job-4', machineId: 'box-4', data: { machine: 'box-4', job: 'job-4', credential: 'KUBE_LAB', bound: { namespace: 'lab', secret: 'hopper-mint-d' } } });
    await b.reconcile();
    expect(u.unbound).toEqual([A, { credential: 'KUBE_LAB', namespace: 'web', secret: 'hopper-mint-c' }]);
    expect(events.all.filter((e) => e.type === 'vault.unbound').map((e) => [e.jobId, (e.data as { box: string }).box])).toEqual([['job-2', 'box-2'], ['job-1', 'box-1'], [undefined, 'check-1']]);
    // A second pass has nothing left to do.
    await b.reconcile();
    expect(u.unbound).toHaveLength(2);
  });
});

describe('a need step\'s Kubernetes token is bound to its sandbox (issue #1371)', () => {
  const READ: OperationProfile = { operation: 'read', asset: { kind: 'namespace', name: 'lab/web' } };
  const AWS_READ: OperationProfile = { operation: 'read', asset: { kind: 'aws-role', name: '123456789012/diag' } };

  function minting() {
    const events = eventLog();
    const u = unbinder();
    const targets: MintTarget[] = [];
    const credentials = [
      { id: 's1', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' } },
      { id: 's2', name: 'AWS', mints: { kind: 'aws-account', name: '123456789012' } },
    ];
    const store = {
      config: { read: () => undefined },
      vault: { list: () => credentials, get: (n: string) => credentials.find((c) => c.name === n), replace: () => {}, sealed: () => undefined },
      events, tx: <T>(f: () => T): T => f(), jobs: { get: () => ({ id: 'job-1', status: 'running' }) },
    };
    const bindings = mintBindings({ events, clock, unbindFrom: u.from, logger: { warn: () => {} }, newName: () => `hopper-mint-${targets.length + 1}` });
    const mintFrom: MintFrom = async (credential, target) => {
      targets.push(target);
      if (target.kind === 'aws') return { minted: { kind: 'aws', AccessKeyId: 'ASIA', SecretAccessKey: 's', SessionToken: 't', Expiration: '2030-01-01T00:15:00Z' }, reach: { kind: 'aws', region: 'eu-west-1' } };
      return { minted: { kind: 'kube', token: 'token', expirationTimestamp: '2030-01-01T00:10:00Z' }, reach: { kind: 'kube', server: 'https://lab:6443' }, ...(target.bindTo ? { bound: { namespace: target.namespace, secret: target.bindTo } } : {}) };
    };
    const access = { decideCheckMint: async () => ({ id: 'd1', at: NOW.toISOString(), allowed: true, reason: 'ok' }) };
    const m = needMinting(store as never, { access: access as never, mintFrom, bindings });
    return { m, events, u, targets, bindings };
  }

  it('asks for the token bound to a Secret of its own, records the binding, and holds it for the step', async () => {
    const { m, events, u, targets, bindings } = minting();
    const r = await m.mintForNeedStep({ template: 'kube', step: 'hopper-need-kube-1', job: 'job-1', profile: READ });
    expect('minted' in r).toBe(true);
    expect(targets[0]).toMatchObject({ kind: 'kube', namespace: 'web', bindTo: 'hopper-mint-1' });
    expect(events.all.find((e) => e.type === 'vault.binding_named')?.data).toEqual({ box: 'hopper-need-kube-1', job: 'job-1', credential: 'KUBE_LAB', namespace: 'web', secret: 'hopper-mint-1' });
    expect(events.all.find((e) => e.type === 'vault.minted')?.data).toMatchObject({ credential: 'KUBE_LAB', bound: { namespace: 'web', secret: 'hopper-mint-1' } });
    await bindings.release('hopper-need-kube-1');
    expect(u.unbound).toEqual([{ credential: 'KUBE_LAB', namespace: 'web', secret: 'hopper-mint-1' }]);
  });

  it('a hopper that stops while the minter makes the Secret leaves one Secret, which the reconcile pass unbinds (issue #1628)', async () => {
    const { events, targets } = minting();
    const credentials = [{ id: 's1', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' } }];
    const store = {
      config: { read: () => undefined },
      vault: { list: () => credentials, get: () => credentials[0], replace: () => {}, sealed: () => undefined },
      events, tx: <T>(f: () => T): T => f(), jobs: { get: () => ({ id: 'job-1', status: 'running' }) },
    };
    const before = mintBindings({ events, clock, unbindFrom: unbinder().from, logger: { warn: () => {} }, newName: () => 'hopper-mint-lost' });
    // The minter makes the Secret, and the hopper stops before it answers.
    const made: string[] = [];
    const stopped: MintFrom = async (_credential, target) => {
      targets.push(target);
      if (target.kind === 'kube' && target.bindTo) made.push(target.bindTo);
      return new Promise(() => {});
    };
    const access = { decideCheckMint: async () => ({ id: 'd1', at: NOW.toISOString(), allowed: true, reason: 'ok' }) };
    void needMinting(store as never, { access: access as never, mintFrom: stopped, bindings: before }).mintForNeedStep({ template: 'kube', step: 'hopper-need-kube-1', job: 'job-1', profile: READ });
    await new Promise((r) => setTimeout(r, 10));
    expect(made).toEqual(['hopper-mint-lost']);
    expect(events.all.some((e) => e.type === 'vault.minted')).toBe(false);
    // The hopper starts again: its reconcile pass deletes the Secret, once.
    const u = unbinder();
    const after = mintBindings({ events, clock, unbindFrom: u.from, logger: { warn: () => {} } });
    await after.reconcile();
    await after.reconcile();
    expect(u.unbound).toEqual([{ credential: 'KUBE_LAB', namespace: 'web', secret: 'hopper-mint-lost' }]);
  });

  it('an AWS session is bound to nothing: STS cannot end one session, so it lives its 15 minutes', async () => {
    const { m, events, targets } = minting();
    await m.mintForNeedStep({ template: 'aws', step: 'hopper-need-aws-1', job: 'job-1', profile: AWS_READ });
    expect(targets[0]).not.toHaveProperty('bindTo');
    expect(events.all.find((e) => e.type === 'vault.minted')?.data).not.toHaveProperty('bound');
  });
});
