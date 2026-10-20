// Issue #2159: the job view says the job was woken by a comment, with its link, until the job waits again.
import { describe, expect, it } from 'vitest';
import { wokenByComment } from '../../ui/src/model/comment-wake.ts';
import type { DomainEvent } from '../../ui/src/model/wire.ts';

const URL = 'https://github.com/o/r/issues/1#issuecomment-5';
const ev = (seq: number, type: string, data: Record<string, unknown> = {}): DomainEvent => ({ seq, type, at: '2026-10-19T18:00:00.000Z', jobId: 'j1', data } as DomainEvent);

describe('woken by a comment (wokenByComment)', () => {
  it('the link of the comment that ended the last wait, newest first', () => {
    expect(wokenByComment([ev(3, 'job.started'), ev(2, 'job.wait_ended', { by: 'hopper', comment: URL }), ev(1, 'job.waiting')])).toBe(URL);
  });

  it('nothing when a person or a check ended it, or the job waits again', () => {
    expect(wokenByComment([ev(2, 'job.wait_ended', { by: 'person' }), ev(1, 'job.waiting')])).toBeUndefined();
    expect(wokenByComment([ev(3, 'job.waiting'), ev(2, 'job.wait_ended', { by: 'hopper', comment: URL })])).toBeUndefined();
    expect(wokenByComment([])).toBeUndefined();
  });
});
