// The Grok Bot routine webhook (design.md "Grok Bot routine webhook"): one POST per question that
// reaches the human, read from the env file at each event. In memory only: no store row, no event.
import type { DomainEvent, Notifier, NotifierEvents, PluginLogger } from '../../sdk.ts';
import { readGrokBotEnv } from './env-file.ts';

export interface GrokBotNotifierOptions {
  name: string;
  path: string;
  logger: PluginLogger;
  /** First retry delay; doubles per attempt. Default 1000. */
  baseMs?: number;
  timeoutMs?: number;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retriable = (status: number) => status === 429 || status >= 500;

function wanted(e: DomainEvent): boolean {
  return e.type === 'question.escalated' && e.data.target === 'human' && !e.data.renotify;
}

export function createGrokBotNotifier(o: GrokBotNotifierOptions): Notifier {
  const { path, logger } = o;
  const baseMs = o.baseMs ?? 1000;
  const timeoutMs = o.timeoutMs ?? 10_000;
  let feed: NotifierEvents | undefined;
  const inFlight = new Set<Promise<void>>();
  let unsubscribe: (() => void) | undefined;
  let warnedMode = false;

  function payload(e: DomainEvent): Record<string, unknown> {
    const source = e.jobId ? feed?.job(e.jobId)?.source : undefined;
    const base = { source: 'job-hopper', kind: e.type, at: e.at, jobId: e.jobId ?? null, issueTitle: source?.title ?? null, issueUrl: source?.url ?? null };
    if (e.type === 'question.escalated') {
      return { ...base, question: e.data.text, questionId: e.data.questionId, ...(e.data.answerUrl ? { answerUrl: e.data.answerUrl } : {}) };
    }
    return base;
  }

  async function deliver(e: DomainEvent): Promise<void> {
    const cfg = readGrokBotEnv(path);
    if (cfg.kind === 'absent') return;
    const tag = `grokbot: ${e.type} ${e.jobId ?? ''}`.trim();
    if (cfg.kind === 'invalid') {
      logger.warn(`${tag}: ${path} ${cfg.reason}; skipped`);
      return;
    }
    if (cfg.looseMode && !warnedMode) {
      warnedMode = true;
      logger.warn(`grokbot: ${path} is readable by group or other; chmod 600 it`);
    }
    const body = JSON.stringify(payload(e));
    let last = 'no attempt';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let status: number | undefined;
      try {
        const res = await fetch(cfg.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        await res.body?.cancel();
        if (res.ok) {
          logger.info(`${tag}: delivered (HTTP ${status})`);
          return;
        }
        last = `HTTP ${status}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (status !== undefined && !retriable(status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(baseMs * 2 ** (attempt - 1));
    }
    logger.warn(`${tag}: delivery failed (${last})`);
  }

  function onEvent(e: DomainEvent): void {
    if (!wanted(e)) return;
    // Listeners must not re-enter synchronously (ports.ts): defer the work.
    const p = new Promise<void>((r) => setImmediate(r))
      .then(() => deliver(e))
      .catch((err) => logger.warn(`grokbot: ${e.type} ${e.jobId ?? ''}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }

  return {
    name: o.name,
    start(events) {
      feed = events;
      unsubscribe ??= events.subscribe(onEvent);
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.all(inFlight);
    },
  };
}
