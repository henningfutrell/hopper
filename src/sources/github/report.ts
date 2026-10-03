// report(): what happened to a job, as comments and labels on its issue. Returns the WHOLE
// new source state: { claimCommentId, progressCommentId, questionComments, answeredComments,
// finalCommentId }. With a token keeper (app mode) the claim also mints the job's token file —
// a failed mint never fails the claim — and the final report deletes it.

import { SourceError } from '../../domain/ports.ts';
import type { SourceReport } from '../../domain/ports.ts';
import type { Job, Question } from '../../domain/types.ts';
import { GitHubApiError } from './api.ts';
import type { GitHubApi } from './api.ts';
import { commentBody, postOnce, upsert } from './comments.ts';
import type { CommentTarget } from './comments.ts';
import type { BotLogin } from './identity.ts';
import { HOPPER_LABELS, LABEL_CLAIMED, LABEL_DONE, LABEL_FAILED } from './labels.ts';
import { markerFor } from './markers.ts';
import type { JobTokenKeeper } from './tokens.ts';

export interface ReportContext {
  api: GitHubApi;
  /** Repos whose hopper labels were ensured by this process. */
  labelledRepos: Set<string>;
  /** The bot login in app mode (comment reuse requires the bot author); undefined in gh mode. */
  botLogin: () => Promise<BotLogin>;
  tokens?: JobTokenKeeper;
}

type State = Record<string, unknown>;

function issueOf(job: Job): { repo: string; number: number } {
  const { repo, number } = job.source ?? {};
  if (!repo || !number) throw new SourceError(`job ${job.id} has no GitHub issue reference`, true);
  return { repo, number };
}

function idMap(state: State, key: string): Record<string, number> {
  return { ...((state[key] as Record<string, number> | undefined) ?? {}) };
}

function trail(q: Question): string {
  if (q.attempts.length === 0) return '(no answerer tried it)';
  const yn = (b: boolean | undefined) => (b ? 'yes' : 'no');
  return q.attempts.map((a) => {
    const rules = a.riskRules?.length ? ` · rules: ${a.riskRules.join(', ')}` : '';
    const error = a.error ? ` · error: ${a.error}` : '';
    if (a.role === 'answerer') return `- ${a.tier} (answerer) · confident=${yn(a.confident)} · ${a.outcome}${error}`;
    if (a.role === 'assessor') {
      const verdict = a.escalate === undefined ? 'no verdict' : `escalate=${yn(a.escalate)}`;
      return `- ${a.tier} (assessor) · ${verdict}${a.reason ? ` · ${a.reason}` : ''}${rules}${error}`;
    }
    // Attempts stored before the assessor: both model tiers answered and judged risk themselves.
    return `- ${a.tier} · confident=${yn(a.confident)} · risky=${yn(a.risky)}${rules}${error}`;
  }).join('\n');
}

function resultText(result: unknown): string {
  if (result === undefined || result === null) return '(no result)';
  if (typeof result === 'string') return result;
  return '```json\n' + JSON.stringify(result, null, 2) + '\n```';
}

async function ensureLabels(ctx: ReportContext, repo: string): Promise<void> {
  if (ctx.labelledRepos.has(repo)) return;
  for (const l of HOPPER_LABELS) await ctx.api.ensureLabel(repo, l.name, l.color, l.description);
  ctx.labelledRepos.add(repo);
}

async function final(ctx: ReportContext, t: CommentTarget, r: SourceReport, state: State, text: string, add: string[]): Promise<State> {
  const { job } = r;
  const { repo, number } = t;
  const marker = markerFor(r.kind as 'finished', job.id);
  const id = await postOnce(t, marker, commentBody(marker, text, job.id), state.finalCommentId as number | undefined);
  await ctx.api.removeLabels(repo, number, [LABEL_CLAIMED]);
  if (add.length) {
    await ensureLabels(ctx, repo);
    await ctx.api.addLabels(repo, number, add);
  }
  ctx.tokens?.drop(job);
  return { ...state, finalCommentId: id };
}

async function apply(ctx: ReportContext, r: SourceReport, state: State): Promise<State> {
  const { job } = r;
  const { repo, number } = issueOf(job);
  const t: CommentTarget = { api: ctx.api, repo, number, botLogin: await ctx.botLogin() };
  const post = (marker: string, text: string, known: number | undefined) =>
    postOnce(t, marker, commentBody(marker, text, job.id), known);
  switch (r.kind) {
    case 'claimed': {
      await ensureLabels(ctx, repo);
      await ctx.api.addLabels(repo, number, [LABEL_CLAIMED]);
      const cwd = String(job.spec.payload.cwd ?? '(default)');
      const text = `🦘 job-hopper claimed this as job \`${job.id}\` (priority ${job.priority}, executor ${job.spec.executor}, cwd ${cwd})`;
      const claimCommentId = await post(markerFor('claimed', job.id), text, state.claimCommentId as number | undefined);
      await ctx.tokens?.ensure(job); // never throws; a failure shows in status and refresh retries
      return { ...state, claimCommentId };
    }
    case 'progress': {
      const marker = markerFor('progress', job.id);
      const pct = job.progress === undefined ? '' : `${Math.round(job.progress * 100)}% — `;
      const text = `⏳ progress: ${pct}${r.message}\n\n_updated ${job.updatedAt}_`;
      const id = await upsert(t, marker, commentBody(marker, text, job.id), state.progressCommentId as number | undefined);
      return { ...state, progressCommentId: id };
    }
    case 'question': {
      if (r.question.tier !== 'human') return state;
      const map = idMap(state, 'questionComments');
      const text = `❓ job \`${job.id}\` needs a human answer:\n\n${r.question.text}\n\nEscalation so far:\n${trail(r.question)}\n\nReply to this issue to answer.`;
      map[r.question.id] = await post(markerFor('question', job.id, r.question.id), text, map[r.question.id]);
      return { ...state, questionComments: map };
    }
    case 'answered': {
      const map = idMap(state, 'answeredComments');
      const text = `Answered by ${r.question.answeredBy ?? r.question.tier}: ${r.question.answer ?? ''}`;
      map[r.question.id] = await post(markerFor('answered', job.id, r.question.id), text, map[r.question.id]);
      return { ...state, answeredComments: map };
    }
    case 'finished':
      return final(ctx, t, r, state, `✅ job \`${job.id}\` finished.\n\n${resultText(job.result)}`, [LABEL_DONE]);
    case 'failed':
      return final(ctx, t, r, state, `❌ job \`${job.id}\` failed: ${job.error ?? '(no error recorded)'}`, [LABEL_FAILED]);
    case 'cancelled': {
      const reason = (job.sourceState?.sync?.cancelReason as string | undefined) ?? job.error ?? 'cancelled';
      return final(ctx, t, r, state, `🛑 job \`${job.id}\` cancelled (${reason})`, []);
    }
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
