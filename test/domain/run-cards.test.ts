// Issue #2197: one approval card per sandbox run. A job's ask that waits on a template, on its sandbox run, or on both,
// is one run card; a person never approves a template a job asked for on a card of its own.
import { describe, expect, it } from 'vitest';
import { approvalsOf, runCards, templateCards, waitsForPerson } from '../../src/domain/run-cards.ts';
import type { SandboxRequestView } from '../../src/domain/sandbox-approvals.ts';
import type { TemplateView } from '../../src/domain/vault.ts';

const write = { operation: 'write' as const, asset: { kind: 'aws-role' as const, name: '123456789012/deploy' } };
const read = { operation: 'read' as const, asset: { kind: 'cluster' as const, name: 'lab' } };

const template = (name: string, o: Partial<TemplateView> = {}): TemplateView => ({
  name, image: 'img', secrets: [], profiles: [write, read], savedBy: 'job j1', savedAt: '2026-10-19T01:00:00.000Z',
  pending: { secrets: [], image: false, egress: [], profiles: [] }, gives: [], radius: { level: 'high', reasons: [] },
  approval: { image: 'img', secrets: [], by: 'a person', at: '2026-10-19T00:00:00.000Z' }, ...o,
} as TemplateView);

const waitingTemplate = (name: string, o: Partial<TemplateView> = {}): TemplateView =>
  template(name, { approval: undefined, pending: { secrets: [], image: true, egress: [], profiles: [write, read] }, ...o });

const request = (o: Partial<SandboxRequestView>): SandboxRequestView => ({ id: 'r1', jobId: 'j1', template: 't', state: 'waiting', askedAt: '2026-10-19T02:00:00.000Z', ...o });

const live = (ids: string[]) => (id: string) => (ids.includes(id) ? { title: `job ${id}`, url: `https://example.test/${id}` } : undefined);

describe('run cards (issue #2197)', () => {
  it('a job waiting on a template is one card: the template waits, the run does not, with the job\'s words', () => {
    const cards = runCards({
      templates: [waitingTemplate('asked-1')], requests: [], job: live(['j1']),
      waits: [{ jobId: 'j1', template: 'asked-1', purpose: 'Rotate the key', plan: 'aws iam … (undo: the old key stays a day)', askedAt: '2026-10-19T02:00:00.000Z' }],
    });
    expect(cards).toEqual([{
      jobId: 'j1', jobTitle: 'job j1', jobUrl: 'https://example.test/j1', template: 'asked-1', purpose: 'Rotate the key',
      plan: 'aws iam … (undo: the old key stays a day)', askedAt: '2026-10-19T02:00:00.000Z', waits: { template: true, run: false },
    }]);
  });

  it('a waiting run whose template waits too is still one card, with both waits and the request', () => {
    const cards = runCards({
      templates: [waitingTemplate('t', { askedBy: 'j1' })], requests: [request({ purpose: 'Why' })], job: live(['j1']),
      waits: [{ jobId: 'j1', template: 't', askedAt: '2026-10-19T03:00:00.000Z' }],
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ jobId: 'j1', template: 't', request: 'r1', purpose: 'Why', waits: { template: true, run: true } });
  });

  it('a waiting run of a ready template is a card of the run only; a run that does not wait is none', () => {
    const cards = runCards({ templates: [template('t')], requests: [request({}), request({ id: 'r2', jobId: 'j2', state: 'approved' })], waits: [], job: live(['j1', 'j2']) });
    expect(cards.map((c) => [c.request, c.waits])).toEqual([['r1', { template: false, run: true }]]);
  });

  it('a template a live job asked for that waits is a card with no ask kept (after a restart); one of an ended job is none', () => {
    const cards = runCards({
      templates: [waitingTemplate('a', { askedBy: 'j1', purpose: 'P' }), waitingTemplate('b', { askedBy: 'gone' })], requests: [], waits: [], job: live(['j1']),
    });
    expect(cards.map((c) => [c.template, c.jobId, c.purpose])).toEqual([['a', 'j1', 'P']]);
  });

  it('an ask on a template that no longer waits for a person is no card; two jobs on one template are two cards, oldest first', () => {
    const cards = runCards({
      templates: [template('ready'), waitingTemplate('w')], requests: [], job: live(['j1', 'j2']),
      waits: [
        { jobId: 'j1', template: 'ready', askedAt: '2026-10-19T01:00:00.000Z' },
        { jobId: 'j2', template: 'w', askedAt: '2026-10-19T05:00:00.000Z' },
        { jobId: 'j1', template: 'w', askedAt: '2026-10-19T04:00:00.000Z' },
      ],
    });
    expect(cards.map((c) => c.jobId)).toEqual(['j1', 'j2']);
    expect(cards.every((c) => c.template === 'w')).toBe(true);
  });

  it('a template card is left only for a template a person saved, that no run card holds', () => {
    const own = waitingTemplate('own', { savedBy: 'a person' });
    const asked = waitingTemplate('asked', { askedBy: 'gone' });
    const held = waitingTemplate('held');
    const runs = runCards({ templates: [own, asked, held], requests: [request({ template: 'held' })], waits: [], job: live(['j1']) });
    expect(templateCards([own, asked, held, template('ready')], runs).map((t) => t.name)).toEqual(['own']);
  });

  it('what one approval approves: the template as it is when any of it waits, and each write, sync or apply profile', () => {
    expect(approvalsOf(waitingTemplate('w'))).toEqual({ whole: true, profiles: [write] });
    const onlyWrite = template('t', { pending: { secrets: [], image: false, egress: [], profiles: [write] } });
    expect(approvalsOf(onlyWrite)).toEqual({ whole: false, profiles: [write] });
    expect(waitsForPerson(onlyWrite)).toBe(true);
    expect(waitsForPerson(template('t'))).toBe(false);
    expect(waitsForPerson(template('t', { pending: { secrets: [], image: false, egress: ['h:443'], profiles: [] } }))).toBe(true);
  });
});
