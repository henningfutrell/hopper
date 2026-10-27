// The model review pass (issue #2846 part 3, design.md "Completion reviews"): with the user's model review on, a sweep over
// the completion reviews of the last WINDOW_MS that have no model review asks the model the settings name for one,
// oldest first, one at a time, and keeps it with the review (`completion_review.model_reviewed`). The model is Claude through
// the `claude` CLI in print mode, locked down as the TL;DR's is (`src/plugins/claude-print.ts`): no tools, no MCP, no session,
// the answer bound to a JSON Schema, in the user's work dir. A review the model failed on is kept failed and not asked again.
// The sweep asks only while the model reviews of the last day cost less than the daily cost cap; a run whose cost the CLI did
// not say counts as none. Its lease: on two hosts on one database, only its holder asks the model.
import type { Clock } from '../domain/ports.ts';
import type { UserStore } from '../domain/store.ts';
import { completionReviewSettingsOf, type CompletionReview } from '../domain/completion-review.ts';
import { awaitingModel, modelCostOfDay, modelReviewAnswer, modelReviewPrompt, MODEL_REVIEW_JSON_SCHEMA, type ModelReviewWriter } from '../domain/model-review.ts';
import { soleLease, type SweepLease } from '../domain/leases.ts';
import { claudePrint } from '../plugins/claude-print.ts';
import { maskGitHubTokens } from '../secrets/mask.ts';

export const MODEL_REVIEW_TIMEOUT_MS = 180_000;
/** How often the sweep runs, as the completion review pass. */
export const MODEL_REVIEWS_EVERY_MS = 60_000;
/** How far back the sweep looks: the completion review pass's own window. */
const WINDOW_MS = 2 * 86_400_000;
/** At most this many kept reviews are read per sweep. */
const REVIEWS = 500;
/** At most this many of a job's events go into its timeline. */
const EVENTS = 2000;

/** The model through the `claude` CLI, its cost read from what it printed. */
export function createClaudeReviewWriter(o: { cwd: string; userEnv?: Readonly<Record<string, string>>; bin?: string; timeoutMs?: number }): ModelReviewWriter {
  return async (prompt, model, signal) => {
    let costUsd: number | undefined;
    const r = await claudePrint({
      bin: o.bin ?? 'claude', model, cwd: o.cwd, timeoutMs: o.timeoutMs ?? MODEL_REVIEW_TIMEOUT_MS, jsonSchema: MODEL_REVIEW_JSON_SCHEMA,
      onCost: (usd) => { costUsd = usd; }, ...(o.userEnv ? { userEnv: o.userEnv } : {}),
    }, modelReviewAnswer, prompt, signal);
    return 'error' in r ? r : { ...r, ...(costUsd !== undefined ? { costUsd } : {}) };
  };
}

export interface ModelReviewsOptions {
  store: UserStore;
  clock: Clock;
  writer: ModelReviewWriter;
  logger: { warn(line: string): void };
  sweepMs: number;
  lease?: SweepLease;
}

export interface ModelReviews { start(): void; stop(): Promise<void>; sweep(): Promise<void> }

/** The prompt of a kept review: its job, failure and timeline from the store; undefined when the job is gone. */
function promptOf(store: UserStore, review: CompletionReview): string | undefined {
  const job = store.jobs.get(review.jobId);
  if (!job) return undefined;
  const failure = job.status === 'failed' ? store.failures.forJob(job.id) : undefined;
  const timeline = store.events.recent(EVENTS, undefined, job.id).reverse().map((e) => ({ type: e.type, at: e.at }));
  return maskGitHubTokens(modelReviewPrompt({
    title: job.source?.title || job.spec.goal || `job ${job.id}`, executor: job.spec.executor,
    ...(failure ? { failure: `${failure.causeName ? `${failure.causeName}: ` : ''}${failure.summary}` } : {}),
  }, review, job.createdAt, timeline));
}

export function createModelReviews(o: ModelReviewsOptions): ModelReviews {
  const { store } = o;
  const abort = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweeping: Promise<void> | undefined;
  /** The cap was reached: said once until the day's cost is below it again. */
  let capped = false;

  async function review(r: CompletionReview, model: string): Promise<void> {
    const prompt = promptOf(store, r);
    const at = () => o.clock.now().toISOString();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(MODEL_REVIEW_TIMEOUT_MS)]);
    const answer = prompt === undefined ? { error: 'the job is gone' } : await o.writer(prompt, model, signal).catch((e: unknown) => ({ error: (e as Error).message }));
    if (abort.signal.aborted) return;
    store.tx(() => {
      const now = store.completionReviews.get(r.jobId);
      if (!now || now.modelReview || now.modelFailed) return;
      if ('error' in answer) {
        store.completionReviews.keep({ ...now, modelFailed: { error: answer.error.slice(0, 300), at: at() } });
        store.events.append({ type: 'completion_review.model_reviewed', jobId: r.jobId, data: { model, error: answer.error.slice(0, 300) } });
        return;
      }
      const kept = { ...answer, at: at() };
      store.completionReviews.keep({ ...now, modelReview: kept });
      store.events.append({
        type: 'completion_review.model_reviewed', jobId: r.jobId,
        data: { model: answer.model ?? model, ...(answer.costUsd !== undefined ? { costUsd: answer.costUsd } : {}), ...(answer.hopperDefect ? { hopperDefect: true } : {}) },
      });
    });
    if ('error' in answer) o.logger.warn(`hopper: no model review of job ${r.jobId}: ${answer.error}`);
  }

  async function pass(): Promise<void> {
    const settings = completionReviewSettingsOf(store.settings.getCompletionReview());
    if (!settings.on || !settings.modelReview.on) return;
    const now = o.clock.now();
    const kept = store.completionReviews.since(new Date(now.getTime() - WINDOW_MS).toISOString(), REVIEWS);
    let spent = modelCostOfDay(kept, now);
    for (const r of awaitingModel(kept)) {
      if (abort.signal.aborted) return;
      const cap = completionReviewSettingsOf(store.settings.getCompletionReview()).modelReview;
      if (!cap.on) return;
      if (spent >= cap.dailyCostUsd) {
        if (!capped) o.logger.warn(`hopper: model reviews wait: they cost $${spent.toFixed(2)} in the last day, the cap is $${cap.dailyCostUsd.toFixed(2)}`);
        capped = true;
        return;
      }
      capped = false;
      await review(r, cap.model);
      spent += store.completionReviews.get(r.jobId)?.modelReview?.costUsd ?? 0;
    }
  }

  const lease = o.lease ?? soleLease();
  const sweep = (): Promise<void> => {
    if (!sweeping && !lease.hold().held) return Promise.resolve();
    sweeping ??= pass().catch((e: unknown) => o.logger.warn(`hopper: model review sweep failed: ${(e as Error).message}`)).finally(() => { sweeping = undefined; });
    return sweeping;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void sweep(); }, o.sweepMs);
      void sweep();
    },
    async stop() {
      if (timer) clearInterval(timer);
      abort.abort();
      await sweeping;
    },
    sweep,
  };
}
