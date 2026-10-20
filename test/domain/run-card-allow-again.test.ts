// Issue #2197 part 3: "allow again" on a run card. A run card's approval is for its job's runs only: the template's
// approval names the job (`approval.jobs`), and another job that asks for the same access gets a run card of its own.
// With allow again, the approval is for every job, as each approval made before this part is. Pure.
import { describe, expect, it } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { approvalsOf, runCards, waitsForPerson } from '../../src/domain/run-cards.ts';
import { NO_SKIPS } from '../../src/domain/sandbox-approvals.ts';
import { sandboxesHold, templateReady } from '../../src/domain/sandboxes-before-start.ts';
import { approvalCovers, type TemplateView } from '../../src/domain/vault.ts';
import { coveringTemplate } from '../../src/sandbox/need-steps.ts';
import { createSandboxRequests } from '../../src/sandbox/requests.ts';
import { requestedName, requestTemplate, needsOf, type TemplateRequestUser } from '../../src/skills/template-request.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const WRITE: OperationProfile = { operation: 'write', asset: { kind: 'aws-role', name: '123456789012/deploy' } };
const NEEDS = 'write/aws-role/123456789012/deploy';

const template = (name: string, jobs?: string[], o: Partial<TemplateView> = {}): TemplateView => ({
  name, image: IMAGE, secrets: [], profiles: [WRITE], savedBy: 'job j1', savedAt: '2026-10-20T01:00:00.000Z', askedBy: 'j1',
  approval: { image: IMAGE, secrets: [], by: 'Ada', at: '2026-10-20T01:30:00.000Z', ...(jobs ? { jobs } : {}) },
  pending: { secrets: [], image: false, egress: [], profiles: [] }, gives: [], radius: { level: 'high', reasons: [] }, ...o,
}) as TemplateView;

const live = (ids: string[]) => (id: string) => (ids.includes(id) ? { title: `job ${id}` } : undefined);

describe('allow again on a run card (issue #2197 part 3)', () => {
  it('an approval that names its jobs covers only those jobs; one with no jobs (allow again, or made before) covers every job', () => {
    expect(approvalCovers(template('t', ['j1']), 'j1')).toBe(true);
    expect(approvalCovers(template('t', ['j1']), 'j2')).toBe(false);
    expect(approvalCovers(template('t', ['j1']), undefined)).toBe(false);
    expect(approvalCovers(template('t'), 'j2')).toBe(true);
    expect(approvalCovers(template('t'), undefined)).toBe(true);
    expect(approvalCovers(template('t', undefined, { approval: undefined }), 'j1')).toBe(false);
  });

  it('for another job, the template waits for a person: its run card shows the template waits, and one approval approves it again', () => {
    const once = template('asked-1', ['j1']);
    expect(waitsForPerson(once, 'j1')).toBe(false);
    expect(waitsForPerson(once, 'j2')).toBe(true);
    expect(approvalsOf(once, 'j1')).toEqual({ whole: false, profiles: [] });
    expect(approvalsOf(once, 'j2')).toEqual({ whole: true, profiles: [] });
    const cards = runCards({
      templates: [once], requests: [], job: live(['j1', 'j2']),
      waits: [{ jobId: 'j1', template: 'asked-1', askedAt: '2026-10-20T02:00:00.000Z' }, { jobId: 'j2', template: 'asked-1', purpose: 'Same fix', askedAt: '2026-10-20T03:00:00.000Z' }],
    });
    expect(cards.map((c) => [c.jobId, c.waits])).toEqual([['j2', { template: true, run: false }]]);
  });

  it('a need step and a box step take the template only for a job its approval covers', () => {
    const once = template('asked-1', ['j1']);
    expect(templateReady(once, 'j1')).toBe(true);
    expect(templateReady(once, 'j2')).toBe(false);
    expect(coveringTemplate([once], [WRITE], 'j1')?.name).toBe('asked-1');
    expect(coveringTemplate([once], [WRITE], 'j2')).toBeUndefined();
    expect(coveringTemplate([once, template('again')], [WRITE], 'j2')?.name).toBe('again');
    const approved = { id: 'r1', template: 'asked-1', state: 'approved' as const, askedAt: '2026-10-20T02:00:00.000Z' };
    expect(sandboxesHold([{ ...approved, jobId: 'j1' }], [once])).toBeUndefined();
    expect(sandboxesHold([{ ...approved, jobId: 'j2' }], [once])).toContain('template asked-1 waits for a person');
  });

  it('a template request of another job waits for a person, and no other job reuses the template', async () => {
    const name = requestedName(needsOf(NEEDS) as OperationProfile[]);
    const templates = new Map([[name, template(name, ['j1'])]]);
    const u: TemplateRequestUser = {
      template: (n) => templates.get(n), templates: () => [...templates.values()],
      save: async () => ({ ok: true }), approve: async () => ({ ok: true }), approveProfile: async () => ({ ok: true }),
      policy: () => undefined, image: IMAGE,
    };
    expect(await requestTemplate(u, { needs: NEEDS }, 'job j1', 'j1')).toMatchObject({ status: 200, template: name });
    const other = await requestTemplate(u, { needs: NEEDS }, 'job j2', 'j2');
    expect(other).toMatchObject({ status: 202, template: name });
    expect('text' in other && other.text).toContain('approved for another job\'s runs only');
    // A template approved for one job is never another job's reuse.
    templates.set('mine', template('mine', ['j1'], { askedBy: undefined }));
    templates.delete(name);
    const reused = await requestTemplate(u, { needs: NEEDS }, 'job j2', 'j2');
    expect(reused).not.toMatchObject({ template: 'mine' });
  });

  it('a person\'s approval for one job approves no other job\'s sandbox run', () => {
    const once = template('asked-1', ['j1']);
    const requests = createSandboxRequests({
      record: () => {}, approvals: () => NO_SKIPS, template: (n) => (n === once.name ? once : undefined), live: () => true,
      clock: { now: () => new Date('2026-10-20T04:00:00Z') },
    });
    requests.waited('j2', once.name);
    expect(requests.ask('j2', once.name).state).toBe('waiting');
    expect(requests.ask('j1', once.name).state).toBe('approved');
  });
});
