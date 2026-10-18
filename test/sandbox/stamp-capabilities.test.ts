// Issue #655 part 16: a job's sandbox request against its stamp's capabilities. A run of a template with a profile whose
// minimum trust the job's level does not meet is declined at once by the minimum trust (gate 2's policy stage): whatever
// the toggles say, with no Jev check and no person's card, and the job's trust stays. A run approved before a minimum was
// set no longer runs a box step.
import { describe, expect, it } from 'vitest';
import type { MinTrust, NewEvent, OperationProfile } from '../../src/domain/types.ts';
import { MIN_TRUST_DECLINER, outsideStamp } from '../../src/domain/stamp-capabilities.ts';
import type { TrustLevel } from '../../src/domain/trust-stamp.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';

const WRITE_X: OperationProfile = { operation: 'write', asset: { kind: 'cluster', name: 'x' } };
const PROD = { name: 'prod', profiles: [WRITE_X], radius: { level: 'high' } } as unknown as TemplateView;
const DOCS = { name: 'docs', profiles: [], radius: { level: 'low' } } as unknown as TemplateView;
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(level: TrustLevel) {
  const events: NewEvent[] = [];
  const asks: string[] = [];
  const denied: string[] = [];
  let mins: MinTrust[] = [{ profile: WRITE_X, level: 'trusted', setBy: 'admin', setAt: '2026-10-17T10:00:00.000Z' }];
  let n = 0;
  const requests = createSandboxRequests({
    record: (e) => events.push(e),
    approvals: () => ({ skipTemplateApproval: false, skipSandboxApproval: true }),
    template: (name) => [PROD, DOCS].find((t) => t.name === name),
    live: () => true,
    outsideStamp: (_jobId, profiles) => outsideStamp(level, profiles, mins),
    jev: { mode: () => 'active', ask: async (a) => { asks.push(a.request.id); return { asked: true, pickId: 'p', pick: 'allow', confidence: 0.95, applied: true }; } },
    jevDenied: (id) => denied.push(id),
    clock: { now: () => new Date('2026-10-17T10:00:00Z') },
    newId: () => `r${++n}`,
  });
  return { requests, events, asks, denied, setMins: (m: MinTrust[]) => { mins = m; } };
}

describe('a sandbox request against the stamp\'s capabilities (issue #655 part 16)', () => {
  it('declines a run above the job\'s trust at once, by the minimum trust, with no Jev check, and lowers no trust', async () => {
    const s = setup('approved');
    const r = s.requests.ask('job-1', PROD.name);
    expect(r).toMatchObject({ state: 'declined', declinedBy: MIN_TRUST_DECLINER, reason: 'the job\'s trust stamp is approved, below the minimum trust trusted to write on cluster x' });
    await tick();
    expect(s.asks).toEqual([]);
    expect(s.denied).toEqual([]);
    expect(s.events.map((e) => e.type)).toEqual(['vault.sandbox_requested', 'vault.sandbox_declined']);
    expect(s.events[1]!.data).toMatchObject({ by: MIN_TRUST_DECLINER });
    expect(s.requests.runnable('job-1')).toEqual([]);
  });

  it('lets a run the job\'s trust meets go on to the approvals', async () => {
    const s = setup('trusted');
    expect(s.requests.ask('job-1', PROD.name)).toMatchObject({ state: 'waiting', jev: { state: 'checking' } });
    await tick();
    expect(s.requests.runnable('job-1')).toEqual([PROD.name]);
    expect(setup('approved').requests.ask('job-1', DOCS.name).state).toBe('approved');
  });

  it('a run approved before a minimum was set runs no box step while the job is below it', async () => {
    const s = setup('approved');
    s.setMins([]);
    expect(s.requests.ask('job-1', PROD.name).state).toBe('waiting');
    await tick();
    expect(s.requests.runnable('job-1')).toEqual([PROD.name]);
    s.setMins([{ profile: WRITE_X, level: 'owner', setBy: 'admin', setAt: '2026-10-17T11:00:00.000Z' }]);
    expect(s.requests.runnable('job-1')).toEqual([]);
    s.setMins([]);
    expect(s.requests.runnable('job-1')).toEqual([PROD.name]);
  });

  it('answers whether needs are outside the job\'s stamp, before any template is made for them', () => {
    const s = setup('approved');
    expect(s.requests.outside('job-1', [WRITE_X])).toContain('below the minimum trust trusted');
    expect(s.requests.outside('job-1', [{ operation: 'read', asset: WRITE_X.asset }])).toBeUndefined();
  });
});
