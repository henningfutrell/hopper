import type { Store } from '../domain/ports.ts';
import type { DomainEvent } from '../domain/types.ts';
import { readGrokBotEnv } from './env-file.ts';

export interface GrokBotNotifierOptions {
  store: Store;
  path: string;
  /** First retry delay; doubles per attempt. Default 1000. */
  baseMs?: number;
  timeoutMs?: number;
  /** Success line sink (lint allows console.log only in main.ts). Default: silent. */
  info?: (line: string) => void;
}

export interface GrokBotNotifier {
  start(): void;
  stop(): Promise<void>;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retriable = (status: number) => status === 429 || status >= 500;

function wanted(e: DomainEvent): boolean {
  if (e.type === 'job.finished' || e.type === 'job.failed') return true;
  return e.type === 'question.escalated' && e.data.target === 'human' && !e.data.renotify;
}

export function createGrokBotNotifier(o: GrokBotNotifierOptions): GrokBotNotifier {
  const { store, path } = o;
  const baseMs = o.baseMs ?? 1000;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const info = o.info ?? (() => {});
  const inFlight = new Set<Promise<void>>();
  let unsubscribe: (() => void) | undefined;
  let warnedMode = false;

  function payload(e: DomainEvent): Record<string, unknown> {
    const source = e.jobId ? store.jobs.get(e.jobId)?.source : undefined;
    const base = { source: 'job-hopper', kind: e.type, at: e.at, jobId: e.jobId ?? null, issueTitle: source?.title ?? null, issueUrl: source?.url ?? null };
    if (e.type === 'job.failed') return { ...base, error: e.data.error };
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
      console.error(`${tag}: ${path} ${cfg.reason}; skipped`);
      return;
    }
    if (cfg.looseMode && !warnedMode) {
      warnedMode = true;
      console.warn(`grokbot: ${path} is readable by group or other; chmod 600 it`);
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
          info(`${tag}: delivered (HTTP ${status})`);
          return;
        }
        last = `HTTP ${status}`;
      } catch (err) {
        last = err instanceof Error ? err.message : String(err);
      }
      if (status !== undefined && !retriable(status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(baseMs * 2 ** (attempt - 1));
    }
    console.error(`${tag}: delivery failed (${last})`);
  }

  function onEvent(e: DomainEvent): void {
    if (!wanted(e)) return;
    // Listeners must not re-enter synchronously (ports.ts): defer the work.
    const p = new Promise<void>((r) => setImmediate(r))
      .then(() => deliver(e))
      .catch((err) => console.error(`grokbot: ${e.type} ${e.jobId ?? ''}: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }

  return {
    start() {
      unsubscribe ??= store.events.subscribe(onEvent);
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      await Promise.all(inFlight);
    },
  };
}
