// The Pull requests list's card states (issue #677): why a pull request waits, in the order that holds first, and a
// pull request with no checks in a yolo repository — waiting for checks to start in the grace window, then ready.
import { describe, expect, it } from 'vitest';
import { MAX_TEND_RETRIES, MAX_TENDS, NO_CHECKS_GRACE_MS, pullRequestList, TEND_RETRY_MS, type Job, type PullRequestSeen } from '../../src/domain/types.ts';
import type { Holds } from '../../src/domain/tending-queue.ts';
import { jobFor, jobForIssue, REPO } from './fixtures/github-support.ts';

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

  it('checks the hopper cannot read: checks unknown, never ready, and the card says why (issue #1244)', () => {
    const why = 'the GitHub App lacks Checks: read: add them to the GitHub App and accept them on its installation';
    expect(waits(seen({ checks: 'unknown', checksWhy: why }))).toMatchObject({ waits: 'checks unknown', checksWhy: why });
    expect(waits(seen({ checks: 'unknown' }))).not.toHaveProperty('checksWhy');
  });

  it('checks no read of which works: one checks read problem per repository, naming its pull requests (issue #1244)', () => {
    const why = 'the GitHub App lacks Checks: read: add them to the GitHub App and accept them on its installation';
    const job = (n: number, s: PullRequestSeen) =>
      jobForIssue(n, { status: 'finished', sourceState: { source: { follow: 'open', pullRequest: `https://github.com/${REPO}/pull/${n + 10}`, seen: s } } });
    const jobs = [job(1, seen({ checks: 'unknown', checksWhy: why, checksRefused: true })), job(2, seen({ checks: 'unknown', checksWhy: why, checksRefused: true })), job(3, seen())];
    const v = pullRequestList(jobs, (key) => jobs.find((j) => j.source!.key === key), { on: true, repos: {} }, [REPO, 'owner/other'], NOW, () => undefined);
    expect(v.checksProblems).toEqual([{ repo: REPO, why, pullRequests: [11, 12] }]);
    expect(v.repos[0]!.pullRequests.filter((c) => c.checksWhy === why)).toHaveLength(2);
  });

  it('checks unknown for a GitHub error, not a refusal: no checks read problem (issue #1244)', () => {
    const job = jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open', pullRequest: PR, seen: seen({ checks: 'unknown', checksWhy: 'GitHub did not answer the read of its checks: timeout' }) } } });
    expect(pullRequestList([job], () => job, { on: true, repos: {} }, [REPO], NOW, () => undefined)).not.toHaveProperty('checksProblems');
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

  it('a tend job not at work yet says why it waits (issue #967): no free lane, or a hold', () => {
    const queued = jobForIssue(1, { id: 'job-2', status: 'queued', rerunOf: 'job-1', waitReason: 'all 2 lanes of the machine are busy' });
    expect(list([tended('job-2')], queued)[0]).toMatchObject({ waits: 'tending', tendWaits: 'all 2 lanes of the machine are busy' });
    const held = jobForIssue(1, { id: 'job-2', status: 'held', rerunOf: 'job-1', holdReason: 'usage pacing' });
    expect(list([tended('job-2')], held)[0]).toMatchObject({ tendWaits: 'usage pacing' });
    const noReason = jobForIssue(1, { id: 'job-2', status: 'queued', rerunOf: 'job-1' });
    expect(list([tended('job-2')], noReason)[0]).toMatchObject({ tendWaits: 'no free lane yet' });
    const running = jobForIssue(1, { id: 'job-2', status: 'running', rerunOf: 'job-1' });
    expect(list([tended('job-2')], running)[0]).not.toHaveProperty('tendWaits');
  });

  it('a companion pull request\'s tend (issue #1143 reopened): the card names the pull request the tend job works on', () => {
    const companion = `https://github.com/${REPO}/pull/8`;
    const job = jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: {
      follow: 'tended', pullRequest: PR, seen: seen(), tended: { pullRequest: companion, step: 'rebase', nextJobId: 'job-2', companion: true },
    } } });
    const tender = jobForIssue(1, { id: 'job-2', status: 'running', rerunOf: 'job-1' });
    expect(list([job], tender)[0]).toMatchObject({ pullRequest: { number: 8, url: companion }, waits: 'tending', tendStep: 'rebase' });
  });

  it('the card names the step the tend job works on (issue #927)', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'running', rerunOf: 'job-1' });
    expect(list([tended('job-2')], tender)[0]).toMatchObject({ tendJobId: 'job-2', tendStep: 'rebase' });
  });

  it('a tend job that failed: the hopper gave up, and says why in the words of the failed job (issue #927)', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'failed', rerunOf: 'job-1',
      error: 'Design-level conflict in src/a.ts:\nboth sides reshape the store. Choose: keep the queue, or keep the stream.' });
    expect(list([tended('job-2')], tender)[0]!.gaveUp)
      .toBe('the job that rebased it failed: Design-level conflict in src/a.ts: both sides reshape the store. Choose: keep the queue, or keep the stream.');
  });

  it('a tend job a person cancelled: the hopper gave up, and a person must look at it', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'cancelled', rerunOf: 'job-1', finishedAt: ago(60_000), sourceState: { sync: { finalReported: true, cancelReason: 'cancelled in UI' } } });
    expect(list([tended('job-2')], tender)[0]).toMatchObject({ waits: 'tend failed', gaveUp: 'the job that rebased it ended cancelled: a person must look at it' });
  });

  it('a tend job cancelled by the sweep or a restart: not given up, tended again after a wait that doubles (issue #1010)', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'cancelled', rerunOf: 'job-1', finishedAt: ago(60_000), sourceState: { sync: { finalReported: true, cancelReason: 'the hopper restarted' } } });
    const card = list([tended('job-2')], tender)[0]!;
    expect(card).toMatchObject({ waits: 'tending', tendWaits: `its tend job was cancelled: tended again from ${new Date(NOW - 60_000 + TEND_RETRY_MS).toISOString()}` });
    expect(card).not.toHaveProperty('gaveUp');
    const again = jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: {
      follow: 'tended', pullRequest: PR, seen: seen({ conflicting: true }), tended: { pullRequest: PR, step: 'rebase', nextJobId: 'job-2', retries: 2 },
    } } });
    expect(list([again], tender)[0]!.tendWaits).toBe(`its tend job was cancelled: tended again from ${new Date(NOW - 60_000 + TEND_RETRY_MS * 4).toISOString()}`);
  });

  it(`a tend job cancelled ${MAX_TEND_RETRIES + 1} times in a row: the hopper gave up, and says so (issue #1010)`, () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'cancelled', rerunOf: 'job-1', finishedAt: ago(60_000) });
    const job = jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: {
      follow: 'tended', pullRequest: PR, seen: seen({ conflicting: true }), tended: { pullRequest: PR, step: 'rebase', nextJobId: 'job-2', retries: MAX_TEND_RETRIES },
    } } });
    expect(list([job], tender)[0]).toMatchObject({ waits: 'tend failed', gaveUp: `the job that rebased it was cancelled ${MAX_TEND_RETRIES + 1} times in a row: a person must look at it` });
  });

  it('a gave-up tend a person asked to tend again: it waits on the tend, not on a person (issue #1010)', () => {
    const tender = jobForIssue(1, { id: 'job-2', status: 'failed', rerunOf: 'job-1', error: 'Design-level conflict.' });
    const job = jobForIssue(1, { id: 'job-1', status: 'finished', sourceState: { source: {
      follow: 'tended', pullRequest: PR, seen: seen({ conflicting: true }), tended: { pullRequest: PR, step: 'rebase', nextJobId: 'job-2', again: ago(1000) },
    } } });
    const card = list([job], tender)[0]!;
    expect(card).toMatchObject({ waits: 'tending', tendWaits: 'a person asked to tend it again: it starts at the next sync' });
    expect(card).not.toHaveProperty('gaveUp');
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
  const job = (n: number, id: string, pullRequest: string, s: PullRequestSeen, over: Partial<Job> = {}, holds: Holds = {}): Job =>
    jobForIssue(n, { id, status: 'finished', sourceState: { source: { follow: 'open', pullRequest, seen: s, ...holds } }, ...over });
  const cards = (jobs: Job[]) => {
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const newest = (key: string) => jobs.filter((j) => j.source?.key === key).at(-1);
    return pullRequestList(jobs, newest, { on: true, repos: {} }, [REPO], NOW, (id) => byId.get(id)).repos[0]!.pullRequests;
  };

  it('the queue is free: it is tended next', () => {
    expect(cards([job(2, 'job-b', PR8, seen({ conflicting: true }))])[0]).toMatchObject({ waits: 'conflicts', queue: { next: true } });
  });

  it('a pull request of the queue that conflicts with it holds it, on its way to the merge: held behind it, and why', () => {
    const head = job(1, 'job-a', PR, seen({ checks: 'pending', pushedAt: ago(60_000) }));
    const behind = job(2, 'job-b', PR8, seen({ checks: 'failing' }), {}, { heldBehind: { pullRequest: PR, why: 'merging' } });
    expect(cards([head, behind]).find((c) => c.jobId === 'job-b')).toMatchObject({ waits: 'checks failing', queue: { held: { pullRequest: 7, why: 'merging' } } });
    expect(cards([head, behind]).find((c) => c.jobId === 'job-a')).not.toHaveProperty('queue');
  });

  it('a hold says since when, and the tend job that holds it with its status (issue #1162)', () => {
    const since = ago(25 * 60_000);
    const behind = job(2, 'job-b', PR8, seen({ conflicting: true }), {}, { heldBehind: { pullRequest: PR, why: 'tending', jobId: 'job-t' }, heldSince: since });
    const holder = jobForIssue(1, { id: 'job-t', status: 'running' });
    expect(cards([behind, holder]).find((c) => c.jobId === 'job-b')).toMatchObject({ queue: { held: { pullRequest: 7, why: 'tending', since, holder: { jobId: 'job-t', status: 'running' } } } });
  });

  it('a tend the source refused: the card says why, not that it is tended next (issue #967)', () => {
    const refused = job(2, 'job-b', PR8, seen({ conflicting: true }), {}, { tendRefused: 'its issue is not assigned to the connected account' });
    expect(cards([refused])[0]).toMatchObject({ waits: 'conflicts', queue: { refused: 'its issue is not assigned to the connected account' } });
  });

  it('a head that does not conflict with it holds nothing (issue #939): it is tended next', () => {
    const head = job(1, 'job-a', PR, seen({ checks: 'pending', pushedAt: ago(60_000) }));
    const free = job(2, 'job-b', PR8, seen({ conflicting: true }));
    expect(cards([head, free]).find((c) => c.jobId === 'job-b')).toMatchObject({ waits: 'conflicts', queue: { next: true } });
  });

  it('a ready pull request whose merge is held (issue #939): it waits for the one merged first, and says which', () => {
    const first = job(1, 'job-a', PR, seen({}));
    const held = job(2, 'job-b', PR8, seen({ mergeHeldBehind: PR }));
    const list = cards([first, held]);
    expect(list.find((c) => c.jobId === 'job-a')).toMatchObject({ waits: 'ready' });
    expect(list.find((c) => c.jobId === 'job-b')).toMatchObject({ waits: 'merge held', queue: { held: { pullRequest: 7, why: 'merging' } } });
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

describe('a direct job\'s pull request (issue #1068)', () => {
  it('has a card with no issue, linked to its direct job', () => {
    const url = 'https://hopper.test/#direct-jobs/d1';
    const job = jobFor({ key: 'direct:d1', url, repo: REPO, author: 'owner', title: 'A direct job' },
      { status: 'finished', sourceState: { source: { follow: 'open', pullRequest: PR, seen: seen() } } }, 'direct');
    const card = pullRequestList([job], () => job, { on: true, repos: {} }, [REPO], NOW, () => undefined).repos[0]!.pullRequests[0]!;
    expect(card).toMatchObject({ jobId: job.id, repo: REPO, directJob: { url }, pullRequest: { number: 7, url: PR }, state: 'open', waits: 'ready' });
    expect(card).not.toHaveProperty('issue');
  });

  it('a job of another source with no issue has none', () => {
    const job = jobFor({ key: 'other:1', url: 'https://example.test/1', repo: REPO, author: 'owner', title: 'Other' },
      { status: 'finished', sourceState: { source: { follow: 'open', pullRequest: PR } } }, 'other');
    expect(pullRequestList([job], () => job, { on: true, repos: {} }, [REPO], NOW, () => undefined).repos[0]!.pullRequests).toEqual([]);
  });
});

describe('a job\'s pull request in another repository (issue #1778)', () => {
  it('its card is in that repository, with that repository\'s yolo mode', () => {
    const other = 'https://github.com/owner/infra/pull/7';
    const job = jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open', pullRequest: other, seen: seen({ conflicting: true, base: 'master' }) } } });
    const v = pullRequestList([job], () => job, { on: false, repos: { 'owner/infra': true } }, [REPO], NOW, () => undefined);
    expect(v.repos.find((g) => g.repo === REPO)!.pullRequests).toEqual([]);
    const card = v.repos.find((g) => g.repo === 'owner/infra')!.pullRequests[0]!;
    expect(card).toMatchObject({ repo: 'owner/infra', issue: { number: 1 }, pullRequest: { number: 7, url: other }, yolo: true, base: 'master', waits: 'conflicts' });
  });

  it('a repository the hopper does not work on (issue #1806): yolo mode only when a person named it on, never by on alone', () => {
    const other = 'https://github.com/zed/tool/pull/7';
    const job = jobForIssue(1, { status: 'finished', sourceState: { source: { follow: 'open', pullRequest: other, seen: seen({ files: ['README.md'], change: { kind: 'docs', why: [], rule: 'x' } }) } } });
    const group = (yolo: { on: boolean; repos: Record<string, boolean> }) => pullRequestList([job], () => job, yolo, [REPO], NOW, () => undefined).repos.find((g) => g.repo === 'zed/tool')!;
    expect(group({ on: true, repos: {} })).toMatchObject({ yolo: false, pullRequests: [{ yolo: false, waits: 'yolo off' }] });
    expect(group({ on: false, repos: { 'zed/tool': true } })).toMatchObject({ yolo: true, pullRequests: [{ yolo: true, waits: 'ready' }] });
  });
});
