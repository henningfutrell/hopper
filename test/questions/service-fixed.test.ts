// Fixed answers (issue #629, design.md "Question pipeline"): before Jev and the levels, a question with an answer
// fixed by facts is answered without a model — a permission dialog the allowed dialogs allow inside the job's work
// tree, or a question a person already answered on the same item. The risk rules still run: a hit goes to a person.
// Anything else goes on to Jev and the levels, as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JevFirst, Job } from '../../src/domain/types.ts';
import { rig, settle } from './support.ts';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-09T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

const TREE = '/work/jobs/job1';

/** A dialog as the herdr executor reads it (screen.ts dialogText): title, what it is about, its question, its options. */
const dialog = (...lines: string[]) => lines.join('\n');
const EDIT_INSIDE = dialog('Edit file', 'src/app.ts', '12 - const a = 1;', '12 + const a = 2;', 'Do you want to make this edit to app.ts?', '1. Yes', '2. Yes, allow all edits during this session (shift+tab)', '3. No, and tell Claude what to do differently (esc)');
const READ_INSIDE = dialog('Read file', `Read(${TREE}/docs/design.md)`, 'Do you want to proceed?', '1. Yes', '2. No, and tell Claude what to do differently (esc)');

function withTree(r: ReturnType<typeof rig>, tree = TREE): void {
  Object.assign(r.job, { workTree: tree });
}

/** Raise a question on `job` (default: the rig's) as the engine does. */
function raise(r: ReturnType<typeof rig>, text: string, detectedBy = 'blocked', job: Job = r.job) {
  return r.mem.store.questions.create({ jobId: job.id, text, recentOutput: '', detectedBy, tier: r.svc.firstStage() });
}

describe('allowed dialogs: a permission dialog inside the job work tree is answered yes, without Jev or a level', () => {
  it('an edit of a file inside the work tree: the dialog is answered with its Yes option', async () => {
    const r = rig();
    withTree(r);
    const q = raise(r, EDIT_INSIDE);
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answer: '1', answeredBy: 'fixed' });
    expect(got.attempts).toEqual([expect.objectContaining({ tier: 'fixed', role: 'fixed', answer: '1', riskRules: [], outcome: 'accepted', reason: expect.stringMatching(/edit inside the job work tree/) })]);
    expect(r.asked).toHaveLength(0);
    expect(r.eventsOf('question.answered')[0]).toMatchObject({ data: { by: 'fixed', answer: '1' } });
    expect(r.answered.map((a) => a.depth)).toEqual([1]);
  });

  it('a read of a file inside the work tree, by its absolute path', async () => {
    const r = rig();
    withTree(r);
    const q = raise(r, READ_INSIDE);
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answer: '1', answeredBy: 'fixed' });
    expect(r.asked).toHaveLength(0);
  });

  it('Jev is not asked about a dialog the allowed dialogs answer', async () => {
    const decide = vi.fn<JevFirst['decide']>(async () => ({ asked: false as const }));
    const r = rig({ first: { decide } });
    withTree(r);
    const q = raise(r, EDIT_INSIDE);
    r.svc.handle(q.id);
    await settle();
    expect(decide).not.toHaveBeenCalled();
    expect(r.mem.store.questions.get(q.id)!.answeredBy).toBe('fixed');
  });

  it.each([
    ['a path outside the work tree', dialog('Read file', 'Read(/etc/hosts)', 'Do you want to proceed?', '1. Yes', '2. No')],
    ['a path that climbs out of the work tree', dialog('Edit file', '../other/app.ts', 'Do you want to make this edit to app.ts?', '1. Yes', '2. No')],
    ['a sibling directory that shares the prefix', dialog('Read file', `Read(${TREE}-other/x.ts)`, 'Do you want to proceed?', '1. Yes', '2. No')],
    ['a path under ~', dialog('Read file', 'Read(~/.ssh/config)', 'Do you want to proceed?', '1. Yes', '2. No')],
    ['a Bash command', dialog('Bash command', 'npm ci', 'Do you want to proceed?', '1. Yes', '2. No')],
    ['a question that names another file', dialog('Edit file', 'src/app.ts', 'Do you want to make this edit to other.ts?', '1. Yes', '2. No')],
    ['no Yes option', dialog('Edit file', 'src/app.ts', 'Do you want to make this edit to app.ts?', '1. Allow', '2. No')],
  ])('%s: goes on to the levels', async (_what, text) => {
    const r = rig();
    withTree(r);
    const q = raise(r, text);
    r.svc.handle(q.id);
    await settle();
    expect(r.asked.map((a) => a.level)).toEqual(['opus']);
    expect(r.mem.store.questions.get(q.id)!.answeredBy).toBe('opus');
  });

  it('a job with no work tree: the levels', async () => {
    const r = rig();
    const q = raise(r, EDIT_INSIDE);
    r.svc.handle(q.id);
    await settle();
    expect(r.asked).toHaveLength(1);
  });

  it('text the agent wrote, not a dialog on the screen (a marker question): the levels', async () => {
    const r = rig();
    withTree(r);
    const q = raise(r, EDIT_INSIDE, 'marker');
    r.svc.handle(q.id);
    await settle();
    expect(r.asked).toHaveLength(1);
  });

  it('a risk rule hit goes to a person, past Jev and every level', async () => {
    const decide = vi.fn<JevFirst['decide']>(async () => ({ asked: false as const }));
    const r = rig({ first: { decide } });
    withTree(r);
    const q = raise(r, dialog('Edit file', 'src/env.ts', '3 + const apiKey = load();', 'Do you want to make this edit to env.ts?', '1. Yes', '2. No'));
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'open', tier: 'human' });
    expect(got.attempts).toEqual([expect.objectContaining({ tier: 'fixed', role: 'fixed', answer: '1', riskRules: ['credentials'], outcome: 'escalated' })]);
    expect(r.eventsOf('question.escalated_to_human')[0]!.data.reason).toBe('risk rules: credentials');
    expect(r.asked).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();
    expect(r.answered).toHaveLength(0);
  });
});

describe('a reused answer: a person already answered the same question on the same item', () => {
  /** A question on `job` a person answered with `answer`. */
  function answeredByPerson(r: ReturnType<typeof rig>, text: string, answer: string, job: Job = r.job) {
    const q = raise(r, text, 'marker', job);
    r.mem.store.questions.update(q.id, { status: 'answered', answer, answeredBy: 'human' });
    return q;
  }

  it('the same question again on the same job: the person\'s answer, without Jev or a level', async () => {
    const decide = vi.fn<JevFirst['decide']>(async () => ({ asked: false as const }));
    const r = rig({ first: { decide } });
    const before = answeredByPerson(r, 'Which database?  ', 'use sqlite');
    const q = raise(r, 'which   database?', 'marker');
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'answered', answer: 'use sqlite', answeredBy: 'fixed' });
    expect(got.attempts).toEqual([expect.objectContaining({ tier: 'fixed', role: 'fixed', answer: 'use sqlite', riskRules: [], outcome: 'accepted', reason: expect.stringContaining(before.id) })]);
    expect(r.asked).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a run again of the same item reuses the answer given on the job before it', async () => {
    const r = rig();
    const earlier = r.mem.addJob('build the thing');
    Object.assign(r.job, { rerunOf: earlier.id });
    answeredByPerson(r, 'Which database?', 'use sqlite', earlier);
    const q = raise(r, 'Which database?', 'marker');
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answer: 'use sqlite', answeredBy: 'fixed' });
    expect(r.asked).toHaveLength(0);
  });

  it('a dialog with a countdown matches the same dialog at another time left', async () => {
    const r = rig();
    const at = (left: string) => dialog('Bash command', 'npm ci', `⚠ Claude Code will automatically deny this request in ${left}, to avoid blocking progress on an unattended session`, 'Do you want to proceed?', '1. Yes', '2. No');
    answeredByPerson(r, at('1:59'), '1');
    const q = raise(r, at('0:42'));
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)).toMatchObject({ status: 'answered', answer: '1', answeredBy: 'fixed' });
  });

  it.each([
    ['another job of another item', (r: ReturnType<typeof rig>) => answeredByPerson(r, 'Which database?', 'use sqlite', r.mem.addJob('other work'))],
    ['an answer a level gave, not a person', (r: ReturnType<typeof rig>) => {
      const q = raise(r, 'Which database?', 'marker');
      r.mem.store.questions.update(q.id, { status: 'answered', answer: 'use sqlite', answeredBy: 'opus' });
    }],
    ['a question the person closed without answering', (r: ReturnType<typeof rig>) => {
      const q = raise(r, 'Which database?', 'marker');
      r.mem.store.questions.update(q.id, { status: 'closed', answer: 'closed', answeredBy: 'human' });
    }],
    ['another question', (r: ReturnType<typeof rig>) => answeredByPerson(r, 'Which cache?', 'use redis')],
  ])('%s: not reused, the levels answer', async (_what, before) => {
    const r = rig();
    before(r);
    const q = raise(r, 'Which database?', 'marker');
    r.svc.handle(q.id);
    await settle();
    expect(r.mem.store.questions.get(q.id)!.answeredBy).toBe('opus');
  });

  it('the risk rules still run: a reused answer they hit goes to a person', async () => {
    const r = rig();
    answeredByPerson(r, 'What next?', 'force-push the branch');
    const q = raise(r, 'What next?', 'marker');
    r.svc.handle(q.id);
    await settle();
    const got = r.mem.store.questions.get(q.id)!;
    expect(got).toMatchObject({ status: 'open', tier: 'human' });
    expect(got.attempts).toEqual([expect.objectContaining({ tier: 'fixed', answer: 'force-push the branch', riskRules: ['force-push'], outcome: 'escalated' })]);
    expect(r.asked).toHaveLength(0);
  });
});
