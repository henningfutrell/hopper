// Issue #655 part 13: Jev's sandbox check on a job's sandbox request. Where the approvals would approve a run with no
// person and sandbox strictness is `standard` for a template not of low blast radius, Jev reads it. In shadow the
// request is approved as before and the pick only recorded. Active, it waits for Jev: allow approves it by Jev, hold
// leaves it to a person with why, deny declines it and lowers the job's trust; no sure pick holds it. A person's answer
// first wins. A run Jev approved counts only while the brake still lets a run go with no person.
import { describe, expect, it } from 'vitest';
import type { MinorDecisionMode, MinorDecisionOutcome } from '../../src/domain/minor-decisions.ts';
import { JEV_APPROVER } from '../../src/domain/sandbox-approvals.ts';
import { DEFAULT_SANDBOX_STRICTNESS, type SandboxStrictness } from '../../src/domain/sandbox-strictness.ts';
import type { SandboxHistoryItem } from '../../src/domain/sandbox-check.ts';
import type { NewEvent } from '../../src/domain/types.ts';
import type { TemplateView } from '../../src/domain/vault.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';

const HIGH = { name: 'aws-prod', radius: { level: 'high' } } as TemplateView;
const LOW = { name: 'read-docs', radius: { level: 'low' } } as TemplateView;
const sure = (pick: string): MinorDecisionOutcome => ({ asked: true, pickId: 'p', pick, confidence: 0.95, applied: true });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function setup(o: { mode: MinorDecisionMode; answer?: MinorDecisionOutcome | (() => Promise<MinorDecisionOutcome>); strictness?: SandboxStrictness }) {
  const events: NewEvent[] = [];
  const asks: { approver: string; shadow: boolean; history: SandboxHistoryItem[] }[] = [];
  const denied: string[] = [];
  let strictness = o.strictness ?? DEFAULT_SANDBOX_STRICTNESS;
  let n = 0;
  const requests = createSandboxRequests({
    record: (e) => events.push(e),
    approvals: () => ({ skipTemplateApproval: false, skipSandboxApproval: true }),
    template: (name) => [HIGH, LOW].find((t) => t.name === name),
    live: () => true,
    strictness: () => strictness,
    jev: {
      mode: () => o.mode,
      ask: async (a) => {
        asks.push({ approver: a.approver, shadow: a.shadow, history: a.history });
        const answer = o.answer ?? sure('allow');
        return typeof answer === 'function' ? answer() : answer;
      },
    },
    jevDenied: (id) => denied.push(id),
    clock: { now: () => new Date('2026-10-17T10:00:00Z') },
    newId: () => `r${++n}`,
  });
  return { requests, events, asks, denied, tighten: (s: SandboxStrictness) => { strictness = s; } };
}

describe('Jev\'s sandbox check (issue #655 part 13)', () => {
  it('in shadow, the approvals approve the run at once, and Jev is asked after, only to record', async () => {
    const s = setup({ mode: 'shadow', answer: sure('deny:out_of_scope') });
    expect(s.requests.ask('job-1', HIGH.name)).toMatchObject({ state: 'approved', approvedBy: 'skip sandbox approval' });
    await tick();
    expect(s.asks).toEqual([{ approver: 'skip sandbox approval', shadow: true, history: [] }]);
    expect(s.requests.list()[0]).toMatchObject({ state: 'approved' });
    expect(s.denied).toEqual([]);
  });

  it('off, or under relaxed, or for a low template, Jev is not asked', async () => {
    const off = setup({ mode: 'off' });
    expect(off.requests.ask('job-1', HIGH.name).state).toBe('approved');
    const relaxed = setup({ mode: 'active', strictness: { ...DEFAULT_SANDBOX_STRICTNESS, default: 'relaxed' } });
    expect(relaxed.requests.ask('job-1', HIGH.name).state).toBe('approved');
    const low = setup({ mode: 'active' });
    expect(low.requests.ask('job-1', LOW.name).state).toBe('approved');
    await tick();
    expect([...off.asks, ...relaxed.asks, ...low.asks]).toEqual([]);
  });

  it('active, the request waits for Jev; allow approves it by Jev', async () => {
    const s = setup({ mode: 'active' });
    expect(s.requests.ask('job-1', HIGH.name)).toMatchObject({ state: 'waiting', jev: { state: 'checking' } });
    await tick();
    const r = s.requests.list()[0]!;
    expect(r).toMatchObject({ state: 'approved', approvedBy: JEV_APPROVER });
    expect(r.jev).toBeUndefined();
    expect(s.events.find((e) => e.type === 'vault.sandbox_approved')!.data).toMatchObject({ by: JEV_APPROVER });
    expect(s.requests.runnable('job-1')).toEqual([HIGH.name]);
  });

  it('active, hold leaves it to a person, with why; a person then approves it', async () => {
    const s = setup({ mode: 'active', answer: sure('hold:novel_target') });
    const id = s.requests.ask('job-1', HIGH.name).id;
    await tick();
    expect(s.requests.list()[0]).toMatchObject({ state: 'waiting', jev: { state: 'held', reason: 'the job reaches a target it has no reason to know' } });
    expect(s.requests.approve(id, 'Ada')).toEqual({ ok: true });
    expect(s.requests.list()[0]).toMatchObject({ state: 'approved', approvedBy: 'Ada' });
    expect(s.requests.list()[0]!.jev).toBeUndefined();
  });

  it('active, deny declines it by Jev with the reason, and lowers the job\'s trust', async () => {
    const s = setup({ mode: 'active', answer: sure('deny:pattern_suspicious') });
    s.requests.ask('job-1', HIGH.name);
    await tick();
    expect(s.requests.list()[0]).toMatchObject({ state: 'declined', declinedBy: JEV_APPROVER, reason: 'the request reads as an attempt to get credentials or to get around a rule' });
    expect(s.events.find((e) => e.type === 'vault.sandbox_declined')!.data).toMatchObject({ by: JEV_APPROVER });
    expect(s.denied).toEqual(['job-1']);
  });

  it('active, no sure answer holds it for a person (fail closed)', async () => {
    for (const answer of [{ asked: false } as const, { asked: true, pickId: 'p', pick: 'allow', confidence: 0.3, applied: false, notApplied: 'below_threshold' } as const, sure('approve')]) {
      const s = setup({ mode: 'active', answer });
      s.requests.ask('job-1', HIGH.name);
      await tick();
      expect(s.requests.list()[0]).toMatchObject({ state: 'waiting', jev: { state: 'held' } });
      expect(s.denied).toEqual([]);
    }
    const thrown = setup({ mode: 'active', answer: () => Promise.reject(new Error('boom')) });
    thrown.requests.ask('job-1', HIGH.name);
    await tick();
    expect(thrown.requests.list()[0]).toMatchObject({ state: 'waiting', jev: { state: 'held', reason: 'Jev gave no answer' } });
  });

  it('a person who answers first wins: Jev\'s later deny changes nothing', async () => {
    let answer!: (o: MinorDecisionOutcome) => void;
    const s = setup({ mode: 'active', answer: () => new Promise((r) => { answer = r; }) });
    const id = s.requests.ask('job-1', HIGH.name).id;
    await tick();
    expect(s.requests.approve(id, 'Ada')).toEqual({ ok: true });
    answer(sure('deny:out_of_scope'));
    await tick();
    expect(s.requests.list()[0]).toMatchObject({ state: 'approved', approvedBy: 'Ada' });
    expect(s.denied).toEqual([]);
  });

  it('Jev reads the job\'s other requests', async () => {
    const s = setup({ mode: 'active', answer: sure('deny:history_denied') });
    s.requests.ask('job-1', HIGH.name);
    await tick();
    s.requests.ask('job-1', 'unrated');
    await tick();
    expect(s.asks[1]!.history).toEqual([expect.objectContaining({ template: HIGH.name, state: 'declined', by: JEV_APPROVER })]);
  });

  it('a run Jev approved counts only while the brake lets a run go with no person', async () => {
    const s = setup({ mode: 'active' });
    s.requests.ask('job-1', HIGH.name);
    await tick();
    s.tighten({ ...DEFAULT_SANDBOX_STRICTNESS, default: 'strict' });
    expect(s.requests.runnable('job-1')).toEqual([]);
    s.tighten(DEFAULT_SANDBOX_STRICTNESS);
    expect(s.requests.runnable('job-1')).toEqual([HIGH.name]);
  });
});
