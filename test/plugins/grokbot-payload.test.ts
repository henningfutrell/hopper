// The Grok Bot routine's question body (issue #485): the machine, its name and the lane are the
// question's own snapshot — where it was raised — not where its job is now. A question with no
// snapshot sends nulls rather than the job's current machine.
import { describe, expect, it } from 'vitest';
import type { Job, Question } from '../../src/domain/types.ts';
import { questionPayload } from '../../src/plugins/notifier/grokbot-routine/payload.ts';

const question = (extra: Partial<Question> = {}): Question => ({
  id: 'q1', jobId: 'j1', text: 'Which branch?', recentOutput: '', detectedBy: 'marker', status: 'open', tier: 'human',
  attempts: [], notifyCount: 1, createdAt: '2026-10-08T10:00:00.000Z', updatedAt: '2026-10-08T10:00:00.000Z', ...extra,
});

// The job moved on after asking: it runs on another machine's lane now, and resumes elsewhere.
const moved = { id: 'j1', status: 'running', laneId: 'study/lane-3', resumeOn: 'study', priority: 50, spec: { executor: 'test', payload: {}, machineId: 'study' } } as unknown as Job;

const payload = (q: Question) => questionPayload({ question: q, job: moved, answerUrl: undefined, at: 'x', now: new Date('2026-10-08T10:01:00.000Z'), offered: false });

describe('Grok Bot routine: the question body names the raising machine (issue #485)', () => {
  it('the question\'s snapshot, not the job\'s current machine, and the machine name', () => {
    const body = payload(question({ raisedBy: { machineId: 'desk', name: 'Desk tower', laneId: 'desk/lane-1' } }));
    expect(body).toMatchObject({ machineId: 'desk', machineName: 'Desk tower', laneId: 'desk/lane-1' });
  });

  it('a snapshot with no name or lane: null for those', () => {
    expect(payload(question({ raisedBy: { machineId: 'desk' } }))).toMatchObject({ machineId: 'desk', machineName: null, laneId: null });
  });

  it('no snapshot: nulls, never the job\'s current machine', () => {
    expect(payload(question())).toMatchObject({ machineId: null, machineName: null, laneId: null });
  });
});

describe('Grok Bot routine: the question body says whether its job is high priority (issue #535)', () => {
  const at = (job: Job, highPriority?: number) => questionPayload({ question: question(), job, answerUrl: undefined, at: 'x', now: new Date('2026-10-08T10:01:00.000Z'), offered: false, highPriority });

  it('at or above the threshold: high', () => {
    expect(at({ ...moved, priority: 75 }, 75)).toMatchObject({ priority: 75, high: true });
    expect(at(moved, 75)).toMatchObject({ priority: 50, high: false });
  });

  it('the threshold not known: null', () => {
    expect(at(moved)).toMatchObject({ priority: 50, high: null });
  });
});

describe('Grok Bot routine: the question body carries the Markdown source (issue #569)', () => {
  it('the question as the agent wrote it, unchanged, and says it is Markdown', () => {
    const text = '## Branch\n\nWhich branch do I rebase onto?\n\n1. `dev`\n2. `main`\n\n<b>not HTML</b>';
    expect(payload(question({ text }))).toMatchObject({ question: text, questionFormat: 'markdown' });
  });
});
