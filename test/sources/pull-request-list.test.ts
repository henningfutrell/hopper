// The Pull requests list's card states (issue #677): why a pull request waits, in the order that holds first, and a
// pull request with no checks in a yolo repository — waiting for checks to start in the grace window, then ready.
import { describe, expect, it } from 'vitest';
import { MAX_TENDS, NO_CHECKS_GRACE_MS, pullRequestList, type Job, type PullRequestSeen } from '../../src/domain/types.ts';
import { jobForIssue, REPO } from './fixtures/github-support.ts';

const NOW = Date.parse('2026-10-02T10:00:00.000Z');
const PR = `https://github.com/${REPO}/pull/7`;

function waits(seen: PullRequestSeen | undefined, o: { yolo?: boolean; pullRequest?: string | null; untrusted?: boolean } = {}) {
  const pullRequest = o.pullRequest === null ? {} : { pullRequest: o.pullRequest ?? PR };
  const base = jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open', ...pullRequest, ...(seen ? { seen } : {}) } } });
  const { origin: _o, ...source } = base.source!;
  const job: Job = o.untrusted ? { ...base, source } : base;
  const v = pullRequestList([job], () => job, { on: o.yolo ?? true, repos: {} }, [REPO], NOW, () => undefined);
  return v.repos[0]!.pullRequests[0]!;
}

const seen = (over: Partial<PullRequestSeen> = {}): PullRequestSeen => ({ draft: false, conflicting: false, checks: 'passing', base: 'dev', ...over });
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('why a pull request waits (issue #677)', () => {
  it('no pull request found yet: says so, not "not checked yet"', () => {
    expect(waits(undefined, { pullRequest: null }).waits).toBe('no pull request');
  });

  it('a named pull request not seen yet: not checked yet', () => {
    expect(waits(undefined).waits).toBe('not checked yet');
  });

  it('merge conflicts: the card carries the base branch', () => {
    expect(waits(seen({ conflicting: true }))).toMatchObject({ waits: 'conflicts', base: 'dev' });
  });

  it('yolo on, checks passed, no refusal: ready, merging', () => {
    expect(waits(seen()).waits).toBe('ready');
  });

  it('yolo on, checks running: checks pending', () => {
    expect(waits(seen({ checks: 'pending' })).waits).toBe('checks pending');
  });

  it('yolo on, no checks, pushed inside the grace window: checks not started', () => {
    expect(waits(seen({ checks: 'none', pushedAt: ago(NO_CHECKS_GRACE_MS - 1000) })).waits).toBe('checks not started');
  });

  it('yolo on, no checks after the grace window: ready, merging', () => {
    expect(waits(seen({ checks: 'none', pushedAt: ago(NO_CHECKS_GRACE_MS + 1000) })).waits).toBe('ready');
    expect(waits(seen({ checks: 'none' })).waits).toBe('ready');
  });

  it('yolo on, a job with no origin (neither a trusted origin nor approved): ready, the hopper merges it (issue #805)', () => {
    expect(waits(seen(), { untrusted: true }).waits).toBe('ready');
    expect(waits(seen(), { untrusted: true, yolo: false }).waits).toBe('yolo off');
  });

  it('yolo on, checks the hopper cannot read (issue #855): checks unknown, never merged', () => {
    expect(waits(seen({ checks: 'unknown', pushedAt: ago(NO_CHECKS_GRACE_MS + 1000) })).waits).toBe('checks unknown');
  });

  it('a refused merge says so', () => {
    expect(waits(seen({ checks: 'none', mergeError: 'Required status check "test" is expected' })).waits).toBe('merge refused');
  });

  it('yolo off: it waits for a person', () => {
    expect(waits(seen({ checks: 'none' }), { yolo: false }).waits).toBe('yolo off');
  });
});

describe('a pull request its item\'s tend job works on (issue #763)', () => {
  const tended = (nextJobId: string): Job => jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: {
    follow: 'tended', pullRequest: PR, seen: seen({ conflicting: true }), tended: { pullRequest: PR, step: 'rebase', nextJobId },
  } } });
  const list = (jobs: Job[], newest: Job) => pullRequestList(jobs, () => newest, { on: true, repos: {} }, [REPO], NOW, () => undefined).repos[0]!.pullRequests;

  it('stays on the list while the tend job runs: open, waiting on the tend', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'running', rerunOf: 'job-1' });
    expect(list([tended('job-2')], tender)).toEqual([expect.objectContaining({ jobId: 'job-1', state: 'open', pullRequest: { number: 7, url: PR }, waits: 'tending' })]);
  });

  it('a tend job that failed: the pull request stays, waiting on a person', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'failed', rerunOf: 'job-1' });
    expect(list([tended('job-2')], tender)).toEqual([expect.objectContaining({ jobId: 'job-1', waits: 'tend failed' })]);
  });

  it('a tend job that finished: only its own card, the one it follows', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'finished', rerunOf: 'job-1', sourceState: { source: { follow: 'open', pullRequest: PR, seen: seen() } } });
    expect(list([tended('job-2'), tender], tender).map((c) => c.jobId)).toEqual(['job-2']);
  });

  it('an older tend, not the newest job of its item: no card', () => {
    const newest = jobForIssue(1, { id: 'job-3', status: 'running', rerunOf: 'job-2' });
    expect(list([tended('job-2')], newest)).toEqual([]);
  });
});

describe('what the hopper does about a pull request that needs tending (issue #927)', () => {
  const PR8 = `https://github.com/${REPO}/pull/8`;
  const job = (n: number, id: string, pullRequest: string, s: PullRequestSeen, over: Partial<Job> = {}): Job =>
    jobForIssue(n, { id, status: 'finished', sourceState: { source: { follow: 'open', pullRequest, seen: s } }, ...over });
  const cards = (jobs: Job[]) => {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const newest = (key: string) => jobs.filter((j) => j.source?.key === key).at(-1);
    return pullRequestList(jobs, newest, { on: true, repos: {} }, [REPO], NOW, (id) => byId.get(id)).repos[0]!.pullRequests;
  };

  it('the queue is free: it is tended next', () => {
    expect(cards([job(2, 'job-b', PR8, seen({ conflicting: true }))])[0]).toMatchObject({ waits: 'conflicts', queue: { next: true } });
  });

  it('another pull request holds the queue on its way to the merge: held behind it, and why', () => {
    const head = job(1, 'job-a', PR, seen({ checks: 'pending', pushedAt: ago(60_000) }));
    const behind = job(2, 'job-b', PR8, seen({ checks: 'failing' }));
    expect(cards([head, behind]).find((c) => c.jobId === 'job-b')).toMatchObject({ waits: 'checks failing', queue: { held: { pullRequest: 7, why: 'merging' } } });
    expect(cards([head, behind]).find((c) => c.jobId === 'job-a')).not.toHaveProperty('queue');
  });

  it('its checks were fixed the most times in a row and still fail: the hopper gave up, and says why; not in the queue', () => {
    const chain: Job[] = [];
    for (let i = 0; i < MAX_TENDS; i++) {
      chain.push(jobForIssue(2, { id: `job-${i}`, status: 'finished', ...(i > 0 ? { rerunOf: `job-${i - 1}` } : {}),
        sourceState: { source: { follow: 'tended', pullRequest: PR8, tended: { pullRequest: PR8, step: 'fix_checks', nextJobId: `job-${i + 1}` } } } }));
    }
    const last = job(2, `job-${MAX_TENDS}`, PR8, seen({ checks: 'failing' }), { rerunOf: `job-${MAX_TENDS - 1}` });
    const card = cards([...chain, last]).find((c) => c.jobId === last.id)!;
    expect(card.gaveUp).toMatch(/checks still fail after 3 fixes/);
    expect(card).not.toHaveProperty('queue');
  });
});
