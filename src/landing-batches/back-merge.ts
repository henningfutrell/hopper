// A batch run with merge conflicts (issue #1073 part 4, design.md "Landing batches"): the batch runner's back-merge. The
// tested branch is merged into a branch at the landing tip by GitHub's own merge (`startBackMerge`), and a pull request
// of it is opened into the landing branch; each pass then merges it once GitHub lets it (`backMergePass`). A real
// conflict is recorded, and one issue is filed with the hopper label, assigned to the user, so Intake takes it. Each
// step an event, with the user's own GitHub connection; the state and the text are `src/domain/landing-back-merge.ts`.
// The back-merge is recorded due with the batch run's failure; a pass that stopped on its way starts it again, and finds
// its pull request and its issue before it makes them (issue #1589, `once.ts`).
import { backMergeBody, backMergeBranch, backMergeIssueText, backMergeTitle, type BackMerge } from '../domain/landing-back-merge.ts';
import { JOB_LABEL } from '../repo-checks/service.ts';
import { fileOnce, openOnce } from './once.ts';
import type { RedPass } from './red.ts';

const short = (sha: string): string => sha.slice(0, 12);

/** After the batch run `batch` at `tip` had merge conflicts with the tested branch: the back-merge, or why there is none. */
export async function startBackMerge(p: RedPass, f: { tip: string; batch: number }): Promise<void> {
  const b = { landing: p.landing, tested: p.tested, tip: f.tip, batch: f.batch };
  const branch = backMergeBranch(f.tip);
  // A branch a stopped pass made is moved back to the tip, and the merge made again.
  await p.gh.createBranch(p.repo, branch, f.tip);
  const m = await p.gh.mergeInto(p.repo, branch, p.tested, backMergeTitle(b));
  if (m.kind === 'merged') {
    const pr = await openOnce(p.gh, p.repo, { head: branch, base: p.landing, title: backMergeTitle(b), body: backMergeBody(b) });
    p.record({ type: 'landing_batch.back_merge_opened', data: { repo: p.repo, landing: p.landing, tested: p.tested, tip: f.tip, batch: f.batch, branch, merge: m.sha, pullRequest: pr.number, url: pr.url } });
    p.note({ why: `the merge of ${p.tested} into ${p.landing} (#${pr.number}) waits to merge` });
    return;
  }
  await p.gh.deleteBranch(p.repo, branch).catch((e: unknown) => p.log(`hopper: landing batches: ${branch} of ${p.repo} not removed: ${(e as Error).message}`));
  const reason = m.kind === 'conflict'
    ? `${p.tested} has changes that conflict with ${p.landing} at ${short(f.tip)}: GitHub cannot merge them`
    : `${p.landing} at ${short(f.tip)} has everything ${p.tested} has: nothing to merge`;
  p.record({ type: 'landing_batch.back_merge_failed', data: { repo: p.repo, tip: f.tip, batch: f.batch, conflict: m.kind === 'conflict', reason } });
  p.note({ why: reason });
  const now = p.state()?.backMerge;
  if (now) await backMergePass(p, now);
}

/** The back-merge's next step: its pull request merged once GitHub lets it; for a real conflict, its issue, once. */
export async function backMergePass(p: RedPass, b: BackMerge): Promise<void> {
  if (b.state === 'open' && b.pullRequest !== undefined) {
    const at = { repo: p.repo, tip: b.tip, pullRequest: b.pullRequest, url: b.url ?? '' };
    const removeBranch = async (): Promise<void> => {
      if (b.branch) await p.gh.deleteBranch(p.repo, b.branch).catch((e: unknown) => p.log(`hopper: landing batches: ${b.branch} of ${p.repo} not removed: ${(e as Error).message}`));
    };
    const pr = await p.gh.pullRequest(p.repo, b.pullRequest);
    if (pr.merged) {
      await removeBranch();
      p.record({ type: 'landing_batch.back_merged', data: { ...at, ...(pr.mergeSha ? { merge: pr.mergeSha } : {}) } });
    } else if (pr.state === 'closed') {
      await removeBranch();
      p.record({ type: 'landing_batch.back_merge_failed', data: { ...at, ...(b.batch !== undefined ? { batch: b.batch } : {}), conflict: false, reason: `the back-merge #${b.pullRequest} was closed without a merge` } });
    } else {
      try {
        const m = await p.gh.merge(p.repo, b.pullRequest, pr.headSha, `Merge ${p.tested} into ${p.landing}: the batch runs had merge conflicts`);
        await removeBranch();
        p.record({ type: 'landing_batch.back_merged', data: { ...at, merge: m.sha } });
      } catch (e) {
        p.note({ why: `the back-merge #${b.pullRequest} waits: ${(e as Error).message}` });
      }
    }
    return;
  }
  if (b.state !== 'failed' || !b.conflict || p.state()?.backMergeIssue) return;
  const login = p.login();
  if (login === undefined) { p.note({ problem: 'no GitHub account is connected: the issue for the merge conflicts waits' }); return; }
  try {
    const text = backMergeIssueText({ landing: p.landing, tested: p.tested, tip: b.tip, ...(b.batch !== undefined ? { batch: b.batch } : {}) });
    const filed = await fileOnce(p.gh, p.repo, { ...text, labels: [JOB_LABEL], assignees: [login] }, b.at);
    p.record({ type: 'landing_batch.back_merge_issue_filed', data: { repo: p.repo, tip: b.tip, issue: filed.number, url: filed.url } });
  } catch (e) {
    p.note({ problem: `the issue for the merge conflicts at ${short(b.tip)} was not filed: ${(e as Error).message}` });
  }
}
