// The Grok Bot routine webhook (design.md "Grok Bot routine webhook"): one POST per question that
// reaches the human (`question.escalated_to_human`, issue #481: never a level hop or a re-notification), per stop of intake (issue #358: `source.stalled`, `connected_account.expired`), and per new artifact (issue #673: `artifact.created`, with its link), the URL and key read from the runtime at each use.
// Issue #378: the questions already open at the human are offered once each when the routine becomes
// configured (a question escalated while it was not is not lost); Send test event and Send open
// questions are the UI's actions. In memory only: no store row, no event.
import type { Clock, DomainEvent, Notifier, NotifierActionResult, NotifierEvents, PluginLogger, Question } from '../../sdk.ts';
import { artifactPayload, intakePayload, questionPayload, testPayload } from './payload.ts';

/** The routine's URL and bearer key now, or why there are none. */
export type Routine = { url: string; key: string } | { problem: string };

export interface GrokBotNotifierOptions {
  name: string;
  routine(): Routine;
  logger: PluginLogger;
  clock: Clock;
  /** First retry delay; doubles per attempt. Default 1000. */
  baseMs?: number;
  timeoutMs?: number;
  /** How often to check whether the routine became configured. Default 5000. */
  watchMs?: number;
}

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retriable = (status: number) => status === 429 || status >= 500;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function wanted(e: DomainEvent): boolean {
  if (e.type === 'source.stalled' || e.type === 'connected_account.expired' || e.type === 'artifact.created') return true;
  return e.type === 'question.escalated_to_human';
}

export function createGrokBotNotifier(o: GrokBotNotifierOptions): Notifier {
  const { logger, clock } = o;
  const baseMs = o.baseMs ?? 1000;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const watchMs = o.watchMs ?? 5000;
  let feed: NotifierEvents | undefined;
  const inFlight = new Set<Promise<unknown>>();
  /** Questions sent (or being sent) by this process: an offer skips them. */
  const sent = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let configured = false;

  const routine = (): Routine => {
    try { return o.routine(); } catch (e) { return { problem: message(e) }; }
  };

  /** One POST; the receiver's status, or why none answered. */
  async function postOnce(url: string, key: string, body: string): Promise<{ status?: number; error?: string }> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      return { status: res.status };
    } catch (err) {
      return { error: message(err) };
    }
  }

  /** Deliver with retries; true once a 2xx answered. Nothing is sent while the routine is not configured. */
  async function deliver(tag: string, payload: Record<string, unknown>): Promise<boolean> {
    const cfg = routine();
    if ('problem' in cfg) return false;
    const body = JSON.stringify(payload);
    let last = 'no attempt';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const r = await postOnce(cfg.url, cfg.key, body);
      if (r.status !== undefined && r.status >= 200 && r.status < 300) {
        logger.info(`${tag}: delivered (HTTP ${r.status})`);
        return true;
      }
      last = r.status !== undefined ? `HTTP ${r.status}` : r.error ?? 'no answer';
      if (r.status !== undefined && !retriable(r.status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(baseMs * 2 ** (attempt - 1));
    }
    logger.warn(`${tag}: delivery failed (${last})`);
    return false;
  }

  function sendQuestion(q: Question, offered: boolean, at: string): Promise<boolean> {
    sent.add(q.id);
    const payload = questionPayload({ question: q, job: feed?.job(q.jobId), answerUrl: feed?.answerUrl(q.id), at, now: clock.now(), offered, highPriority: feed?.highPriority?.(), tldr: feed?.tldr?.(q) });
    return deliver(`grokbot: question.escalated_to_human ${q.jobId}${offered ? ' (open question)' : ''}`, payload);
  }

  function track<T>(p: Promise<T>, what: string): void {
    const q = p.catch((err) => logger.warn(`grokbot: ${what}: ${message(err)}`)).finally(() => inFlight.delete(q));
    inFlight.add(q);
  }

  function onEvent(e: DomainEvent): void {
    if (!wanted(e)) return;
    // Listeners must not re-enter synchronously (ports.ts): defer the work.
    track(new Promise<void>((r) => setImmediate(r)).then(() => {
      const job = e.jobId ? feed?.job(e.jobId) : undefined;
      if (e.type === 'artifact.created') return deliver(`grokbot: ${e.type} ${e.jobId ?? ''}`.trim(), artifactPayload(e, job, feed?.artifactUrl?.(String(e.data.artifact))));
      if (e.type !== 'question.escalated_to_human') return deliver(`grokbot: ${e.type} ${e.jobId ?? ''}`.trim(), intakePayload(e, job));
      const q = feed?.question(e.data.questionId as string);
      if (!q || sent.has(q.id) || 'problem' in routine()) return false;
      return sendQuestion(q, false, e.at);
    }), `${e.type} ${e.jobId ?? ''}`);
  }

  /** The questions open at the human now, each sent once; `again`: the ones sent before too. */
  async function sendOpen(again: boolean): Promise<NotifierActionResult> {
    const cfg = routine();
    if ('problem' in cfg) return { ok: false, detail: cfg.problem, sent: 0, failed: 0 };
    const open = (feed?.waitingOnHuman() ?? []).filter((q) => again || !sent.has(q.id));
    const at = clock.now().toISOString();
    const results = await Promise.all(open.map((q) => sendQuestion(q, true, at)));
    const ok = results.filter(Boolean).length;
    const failed = results.length - ok;
    return { ok: failed === 0, detail: `${ok} of ${results.length} open questions sent`, sent: ok, failed };
  }

  /** The routine became configured since the last look: offer what is open. */
  function watch(): void {
    const now = !('problem' in routine());
    if (now && !configured) {
      logger.info(`grokbot: ${o.name}: routine configured; sending the questions open at the human`);
      track(sendOpen(false), 'open questions');
    }
    configured = now;
  }

  return {
    name: o.name,
    start(events) {
      feed = events;
      unsubscribe ??= events.subscribe(onEvent);
      // Configured at start: its open questions went out before (a restart sends nothing again).
      configured = !('problem' in routine());
      timer ??= setInterval(watch, watchMs);
      timer.unref();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.all(inFlight);
    },
    async test() {
      const cfg = routine();
      if ('problem' in cfg) return { ok: false, detail: cfg.problem };
      const r = await postOnce(cfg.url, cfg.key, JSON.stringify(testPayload(clock.now().toISOString())));
      if (r.status === undefined) return { ok: false, detail: r.error ?? 'no answer' };
      const ok = r.status >= 200 && r.status < 300;
      logger.info(`grokbot: ${o.name}: test event: HTTP ${r.status}`);
      return { ok, status: r.status, detail: `HTTP ${r.status}` };
    },
    sendOpen: () => sendOpen(true),
  };
}
