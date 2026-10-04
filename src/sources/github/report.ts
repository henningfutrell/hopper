// report(): what happened to a job, written to its issue. The hopper's only issue writes are
// labels (state) and one completion comment: claimed → `hopper:claimed`; finished → one status
// comment (one fixed line of hopper facts, never the job's result) + `hopper:done`; failed → `hopper:failed`; cancelled → the claim
// label goes. Nothing else is posted: no claim, progress, question, answer, failure or cancel
// comment (owner decision, 2026-10-03). Returns the WHOLE new source state: { finalCommentId }. Rows
// written before that rule may still carry claimCommentId, progressCommentId,
// questionComments and answeredComments; they are kept as stored and never read.

import { SourceError } from '../../domain/ports.ts';
import type { SourceReport } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import { commentBody, postOnce } from './comments.ts';
import type { CommentTarget } from './comments.ts';
import type { BotLogin } from './identity.ts';
import { HOPPER_LABELS, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED } from './labels.ts';
import { finishedMarker } from './markers.ts';

export interface ReportContext {
  api: GitHubApi;
  /** Repos whose hopper labels were ensured by this process. */
  labelledRepos: Set<string>;
  /** The bot login in app mode (comment reuse requires the bot author); undefined in gh mode. */
  botLogin: () => Promise<BotLogin>;
}

type State = Record<string, unknown>;

function issueOf(job: Job): { repo: string; number: number } {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) throw new SourceError(`job ${job.id} has no GitHub issue reference`, true);
  return { repo, number };
}

/** `4m12s`, `42s`, `1h3m5s` from startedAt to finishedAt (whole seconds); `duration unknown` without both. */
function duration(job: Job): string {
  if (!job.startedAt || !job.finishedAt) return 'duration unknown';
  const total = Math.max(0, Math.floor((Date.parse(job.finishedAt) - Date.parse(job.startedAt)) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return `${h ? `${h}h` : ''}${h || m ? `${m}m` : ''}${sec}s`;
}

async function ensureLabels(ctx: ReportContext, repo: string): Promise<void> {
  if (ctx.labelledRepos.has(repo)) return;
  for (const l of HOPPER_LABELS) await ctx.api.ensureLabel(repo, l.name, l.color, l.description);
  ctx.labelledRepos.add(repo);
}

/** End of a job on its issue: drop `hopper:claimed`, add the outcome label. */
async function settle(ctx: ReportContext, repo: string, number: number, add: string[]): Promise<void> {
  await ctx.api.removeLabels(repo, number, [LABEL_CLAIMED]);
  if (add.length) {
    await ensureLabels(ctx, repo);
    await ctx.api.addLabels(repo, number, add);
  }
}

/** The one comment the hopper posts: a completion status, once (idempotent via its marker). */
async function finished(ctx: ReportContext, job: Job, repo: string, number: number, state: State): Promise<State> {
  const t: CommentTarget = { api: ctx.api, repo, number, botLogin: await ctx.botLogin() };
  const marker = finishedMarker(job.id);
  // Hopper facts only: no model-written text ever reaches the issue (owner decision, 2026-10-03).
  const text = `job-hopper: finished (job ${job.id.slice(0, 8)}, ${duration(job)})`;
  const id = await postOnce(t, marker, commentBody(marker, text, job.id), state.finalCommentId as number | undefined);
  await settle(ctx, repo, number, [LABEL_DONE]);
  return { ...state, finalCommentId: id };
}

async function apply(ctx: ReportContext, r: SourceReport, state: State): Promise<State> {
  const { job } = r;
  const { repo, number } = issueOf(job);
  switch (r.kind) {
    case 'claimed':
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, [LABEL_CLAIMED]);
      return state;
    case 'finished':
      return finished(ctx, job, repo, number, state);
    case 'failed':
      await settle(ctx, repo, number, [LABEL_FAILED]);
      return state;
    case 'cancelled':
      await settle(ctx, repo, number, []);
      return state;
  }
}

export async function reportToGitHub(ctx: ReportContext, r: SourceReport): Promise<State> {
  const state: State = { ...(r.job.sourceState?.source ?? {}) };
  try {
    return await apply(ctx, r, state);
  } catch (err) {
    if (err instanceof SourceError) throw err;
    if (err instanceof GitHubApiError) throw new SourceError(err.message, err.permanent, err.status);
    throw new SourceError((err as Error).message, false);
  }
}
