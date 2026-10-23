// The Grok Bot routine webhook (design.md "Grok Bot routine webhook"): one POST per question that
// reaches the human (`question.escalated_to_human`, issue #481: never a level hop or a re-notification), per stop of intake (issue #358: `source.stalled`, `connected_account.expired`), per new artifact (issue #673: `artifact.created`, with its link), per job end (issue #795: `job.finished`, `job.failed`), and per login a job waits on (issue #698: `auth.pending`, a new code too, and `auth.expired`, never its URL or code), per out-of-band infrastructure change (issue #871: `infra.out_of_band_recorded`), per machine low on free memory and back (issue #868: `machine.memory_low`, `machine.memory_recovered`), per machine offline and back (issue #1497: `machine.offline`, `machine.back_online`), per blocked work item that waits on a person (issue #1891: `work_item.person_asked`, once per block), per machine over its disk budget and back within it (issue #1203: `machine.disk_over_budget`, `machine.disk_within_budget`), per machine whose disk turns low or critical and back (issue #2494: `machine.disk_low`, `machine.disk_ok`), per new run card (issue #2197: `vault.run_card_opened`, with the job's priority and the Access requests link), per plan of an infrastructure change, its approval and its apply (issue #870 part 4: `infra.plan_recorded`, `infra.plan_approved`, and a `vault.minted` that names a plan and is no renewal, sent as `infra.plan_applied`, each with the watchers of the plan's environments), the URL and key read from the runtime at each use.
// Issue #795: `hopper.reachable` says where the hopper is reached from outside while its tunnel is up — at start, on a new
// URL, on recovery, and on a heartbeat — so the receiver never has to poll for it.
// Issue #378: the questions already open at the human are offered once each when the routine becomes
// configured (a question escalated while it was not is not lost); Send test event and Send open
// questions are the UI's actions. In memory only: no store row, no event.
// Issue #1014: every post passes the routine's outbound guard (a rate limit, a dedupe on the event, a circuit that opens on
// a runaway) and goes into the user's send log (design.md "Outbound sends").
// Issue #1587: each notification about an event is a notifier delivery, a row in the user's store with its key, attempts,
// last error and next try (`NotifierEvents.deliveries`): a stop loses none, and a start sends what is due. The key goes in
// `x-hopper-delivery`, so the receiver dedupes a post sent again after a stop. An open-questions offer, `hopper.reachable`
// and the test event are sent at once, with no row.
import type { Clock, DomainEvent, Notifier, NotifierActionResult, NotifierEvents, PluginLogger, Question } from '../../sdk.ts';
import { NOTIFIER_DELIVERY_KEEP_DAYS, type NotifierDelivery, type NotifierDeliveryRepository } from '../../../domain/notifier-deliveries.ts';
import { createOutbound, createOutboundGuard, type Outbound, type OutboundRequest } from '../../../outbound/index.ts';
import { memoryNotifierDeliveries } from './memory-deliveries.ts';
import { artifactPayload, intakePayload, jobPayload, loginPayload, planPayload, questionPayload, reachablePayload, runCardPayload, testPayload } from './payload.ts';

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
  /** How often to check whether the routine became configured, and where the hopper is reached. Default 5000. */
  watchMs?: number;
  /** How often `hopper.reachable` is sent again while nothing changed. Default 5 minutes. */
  heartbeatMs?: number;
  /** The user's outbound sends (issue #1014). Default: a guard of the notifier's own, and no send log. */
  outbound?: Outbound;
  /** The questions sent and not ended since. Default: a set of its own. */
  sent?: Set<string>;
}

/** What a post is, for the outbound guard: its kind, its job, and the key of the event it is about (none: never a duplicate). */
interface About { kind: string; jobId?: string | undefined; key?: string }

/** What a notification about `e` is sent as: an apply (issue #870 part 4) is a credential minted for a plan. */
const kindOf = (e: DomainEvent) => (e.type === 'vault.minted' ? 'infra.plan_applied' : e.type);
/** What the receiver dedupes by: a question's escalation is one notification per question. */
const keyOf = (e: DomainEvent) => (e.type === 'question.escalated_to_human' ? `question:${String(e.data.questionId)}` : `${e.type}:${e.id}`);
const DAY_MS = 86_400_000;
const PRUNE_EVERY_MS = 3_600_000;

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retriable = (status: number) => status === 429 || status >= 500;
/** The events that end a question: it is never sent again, so `sent` lets it go (issue #1402). */
const QUESTION_ENDS = new Set(['question.answered', 'question.closed', 'question.dismissed', 'question.expired', 'question.lapsed']);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function wanted(e: DomainEvent): boolean {
  if (e.type === 'source.stalled' || e.type === 'connected_account.expired' || e.type === 'artifact.created' || e.type === 'source.request_opened') return true;
  if (e.type === 'work_item.person_asked' || e.type === 'vault.run_card_opened') return true;
  if (e.type === 'job.finished' || e.type === 'job.failed') return true;
  if (e.type === 'auth.pending' || e.type === 'auth.expired' || e.type === 'infra.out_of_band_recorded') return true;
  if (e.type === 'infra.plan_recorded' || e.type === 'infra.plan_approved') return true;
  if (e.type === 'machine.memory_low' || e.type === 'machine.memory_recovered') return true;
  if (e.type === 'machine.disk_over_budget' || e.type === 'machine.disk_within_budget' || e.type === 'machine.disk_low' || e.type === 'machine.disk_ok') return true;
  if (e.type === 'machine.offline' || e.type === 'machine.back_online' || e.type === 'machine.drained_idle') return true;
  // An apply (issue #870 part 4): a credential minted for a plan; its renewal is the same apply going on.
  if (e.type === 'vault.minted') return typeof e.data.plan === 'string' && e.data.renewal !== true;
  return e.type === 'question.escalated_to_human';
}

export function createGrokBotNotifier(o: GrokBotNotifierOptions): Notifier {
  const { logger, clock } = o;
  const baseMs = o.baseMs ?? 1000;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const watchMs = o.watchMs ?? 5000;
  const heartbeatMs = o.heartbeatMs ?? 5 * 60_000;
  const outbound = o.outbound ?? createOutbound({ guard: createOutboundGuard({ clock, logger }), clock });
  let feed: NotifierEvents | undefined;
  const inFlight = new Set<Promise<unknown>>();
  /** Where the notifications are kept: the user's store once started with one. */
  let rows: NotifierDeliveryRepository = memoryNotifierDeliveries(clock);
  /** The deliveries being attempted now, and the retries waiting their backoff. */
  const attempting = new Set<string>();
  const retries = new Set<NodeJS.Timeout>();
  /** Aborts every post at stop: what is not delivered stays due, for the next start. */
  let stopping = new AbortController();
  let running = false;
  let prunedAt = 0;
  /** Questions sent (or being sent) by this process and not ended since: an offer skips them. */
  const sent = o.sent ?? new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let configured = false;
  /** The URL last announced (undefined: none since start, or the hopper was not reached since), when, and whether it was down between. */
  const reach: { url?: string | undefined; at: number; down: boolean; sending: boolean } = { at: 0, down: false, sending: false };

  const routine = (): Routine => {
    try { return o.routine(); } catch (e) { return { problem: message(e) }; }
  };

  /** One POST, with the delivery's key when it has one; the receiver's status, or why none answered. */
  async function postOnce(url: string, key: string, body: string, deliveryKey?: string): Promise<{ status?: number; error?: string }> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(deliveryKey !== undefined ? { 'x-hopper-delivery': deliveryKey } : {}) },
        body,
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), stopping.signal]),
      });
      await res.body?.cancel();
      return { status: res.status };
    } catch (err) {
      return { error: message(err) };
    }
  }

  /**
   * Send at once with retries, with no row (an offer, `hopper.reachable`); true once a 2xx answered. Nothing is sent while the routine is not configured, nor when the
   * outbound guard holds it: a duplicate, an open circuit, no token (issue #1014). Each attempt is in the send log.
   */
  async function deliver(tag: string, payload: Record<string, unknown>, about: About): Promise<boolean> {
    const cfg = routine();
    if ('problem' in cfg) return false;
    const req: OutboundRequest = { sender: 'notifier', name: o.name, url: cfg.url, kind: about.kind, ...(about.jobId ? { jobId: about.jobId } : {}), ...(about.key !== undefined ? { key: about.key } : {}) };
    const asked = outbound.ask(req);
    if (asked !== 'ok') {
      logger.warn(`${tag}: not sent (${asked})`);
      return false;
    }
    const body = JSON.stringify(payload);
    let last = 'no attempt';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const held = outbound.isOpen(req) ? 'circuit-open' : outbound.take(req) > 0 ? 'rate-limited' : undefined;
      if (held) {
        outbound.held(req, held);
        last = held;
        break;
      }
      const r = await postOnce(cfg.url, cfg.key, body);
      outbound.posted(req, r);
      if (r.status !== undefined && r.status >= 200 && r.status < 300) {
        logger.info(`${tag}: delivered (HTTP ${r.status})`);
        return true;
      }
      last = r.status !== undefined ? `HTTP ${r.status}` : r.error ?? 'no answer';
      if ((r.status !== undefined && !retriable(r.status)) || stopping.signal.aborted) break;
      if (attempt < MAX_ATTEMPTS) await sleep(baseMs * 2 ** (attempt - 1));
    }
    logger.warn(`${tag}: delivery failed (${last})`);
    return false;
  }

  /** An offer of an open question (issue #378): sent at once, with no row and no key, so Send open questions sends again on each press. */
  function sendQuestion(q: Question, at: string): Promise<boolean> {
    sent.add(q.id);
    const payload = questionPayload({ question: q, job: feed?.job(q.jobId), answerUrl: feed?.answerUrl(q.id), at, now: clock.now(), offered: true, highPriority: feed?.highPriority?.(), tldr: feed?.tldr?.(q) });
    return deliver(`grokbot: question.escalated_to_human ${q.jobId} (open question)`, payload, { kind: 'question.escalated_to_human', jobId: q.jobId });
  }

  function track<T>(p: Promise<T>, what: string): void {
    const q = p.catch((err) => logger.warn(`grokbot: ${what}: ${message(err)}`)).finally(() => inFlight.delete(q));
    inFlight.add(q);
  }

  /** The payload of a notification about `e`, made now; a string: why there is none. */
  function payloadOf(e: DomainEvent): Record<string, unknown> | string {
    const job = e.jobId ? feed?.job(e.jobId) : undefined;
    if (e.type === 'job.finished' || e.type === 'job.failed') return jobPayload(e, job);
    if (e.type === 'auth.pending' || e.type === 'auth.expired') return loginPayload(e, job, clock.now(), feed?.loginsUrl?.());
    if (e.type === 'infra.plan_recorded' || e.type === 'infra.plan_approved' || e.type === 'vault.minted') return planPayload(e, job, feed?.infraPlan?.(String(e.data.plan)), feed?.infraUrl?.());
    if (e.type === 'vault.run_card_opened') return runCardPayload(e, job, feed?.highPriority?.(), feed?.accessUrl?.());
    if (e.type === 'artifact.created') return artifactPayload(e, job, feed?.artifactUrl?.(String(e.data.artifact)));
    if (e.type !== 'question.escalated_to_human') return intakePayload(e, job, e.type === 'infra.out_of_band_recorded' ? feed?.infraUrl?.() : undefined);
    const q = feed?.question(String(e.data.questionId));
    if (!q) return 'question not found';
    return questionPayload({ question: q, job: feed?.job(q.jobId), answerUrl: feed?.answerUrl(q.id), at: e.at, now: clock.now(), offered: false, highPriority: feed?.highPriority?.(), tldr: feed?.tldr?.(q) });
  }

  const requestOf = (d: Pick<NotifierDelivery, 'kind' | 'jobId' | 'key'>, url: string): OutboundRequest =>
    ({ sender: 'notifier', name: o.name, url, kind: d.kind, ...(d.jobId ? { jobId: d.jobId } : {}), key: d.key });

  /**
   * A new notification about `e`: a row, then its first attempt, in one step, so the outbound guard sees each ask with its
   * post (issue #1014). Nothing is kept while the routine is not configured (a question waits for the offer), nor when the
   * guard holds it: a duplicate, an open circuit.
   */
  function enqueue(e: DomainEvent): void {
    const cfg = routine();
    if ('problem' in cfg) return;
    const question = e.type === 'question.escalated_to_human' ? String(e.data.questionId) : undefined;
    if (question !== undefined && sent.has(question)) return;
    const input = { notifier: o.name, key: keyOf(e), kind: kindOf(e), ...(e.jobId ? { jobId: e.jobId } : {}), event: e };
    const asked = outbound.ask(requestOf(input, cfg.url));
    if (asked !== 'ok') {
      logger.warn(`grokbot: ${input.kind} ${e.jobId ?? ''}: not sent (${asked})`);
      return;
    }
    if (question !== undefined) sent.add(question);
    const d = rows.add(input);
    if (d) run(d);
  }

  function onEvent(e: DomainEvent): void {
    if (QUESTION_ENDS.has(e.type)) sent.delete(String(e.data.questionId));
    if (!wanted(e)) return;
    // Listeners must not re-enter synchronously (ports.ts): defer the work. A stop waits for it, so the row is kept.
    track(new Promise<void>((r) => setImmediate(r)).then(() => enqueue(e)), `${e.type} ${e.jobId ?? ''}`);
  }

  /** One attempt of a delivery: delivered, a retry after its backoff, or failed for good. Stopped meanwhile: due at the next start. */
  async function attempt(d: NotifierDelivery): Promise<void> {
    const tag = `grokbot: ${d.kind} ${d.jobId ?? ''}`.trim();
    const fail = (lastError: string, more: { attempts?: number; lastStatusCode?: number } = {}) => {
      rows.update(d.id, { status: 'failed', lastError, nextAttemptAt: undefined, ...more });
      logger.warn(`${tag}: delivery failed (${lastError})`);
    };
    const cfg = routine();
    if ('problem' in cfg) return fail(cfg.problem);
    const payload = payloadOf(d.event);
    if (typeof payload === 'string') return fail(payload);
    const req = requestOf(d, cfg.url);
    if (outbound.isOpen(req)) {
      outbound.held(req, 'circuit-open');
      return fail('circuit-open');
    }
    // No token: the delivery stays due, and a later sweep sends it; no attempt is spent.
    if (outbound.take(req) > 0) {
      outbound.held(req, 'rate-limited');
      return;
    }
    const r = await postOnce(cfg.url, cfg.key, JSON.stringify(payload), d.key);
    outbound.posted(req, r);
    const attempts = d.attempts + 1;
    if (r.status !== undefined && r.status >= 200 && r.status < 300) {
      rows.update(d.id, { status: 'delivered', attempts, lastStatusCode: r.status, lastError: undefined, nextAttemptAt: undefined });
      logger.info(`${tag}: delivered (HTTP ${r.status})`);
      return;
    }
    if (stopping.signal.aborted) {
      rows.update(d.id, { nextAttemptAt: clock.now().toISOString() });
      return;
    }
    const last = r.status !== undefined ? `HTTP ${r.status}` : r.error ?? 'no answer';
    const status = r.status !== undefined ? { lastStatusCode: r.status } : {};
    if ((r.status !== undefined && !retriable(r.status)) || attempts >= MAX_ATTEMPTS) return fail(last, { attempts, ...status });
    const backoff = baseMs * 2 ** (attempts - 1);
    const next = rows.update(d.id, { status: 'retrying', attempts, ...status, lastError: last, nextAttemptAt: new Date(clock.now().getTime() + backoff).toISOString() });
    if (!next) return;
    const timer = setTimeout(() => { retries.delete(timer); run(next); }, backoff);
    timer.unref();
    retries.add(timer);
  }

  /** Attempt `d` unless it is being attempted already. Stopped: its row stays due, for the next start. */
  function run(d: NotifierDelivery): void {
    if (!running || attempting.has(d.id)) return;
    attempting.add(d.id);
    track(attempt(d).finally(() => attempting.delete(d.id)), `${d.kind} ${d.jobId ?? ''}`);
  }

  /** Attempt every delivery due now; drop the old ones delivered or failed, at most hourly. */
  function sweep(): void {
    if (!running) return;
    try {
      const now = clock.now();
      if (now.getTime() - prunedAt >= PRUNE_EVERY_MS) {
        prunedAt = now.getTime();
        rows.prune(new Date(now.getTime() - NOTIFIER_DELIVERY_KEEP_DAYS * DAY_MS).toISOString());
      }
      for (const d of rows.due(o.name, now)) run(d);
    } catch (e) {
      logger.warn(`grokbot: ${o.name}: deliveries: ${message(e)}`);
    }
  }

  /** The questions open at the human now, each sent once; `again`: the ones sent before too. */
  async function sendOpen(again: boolean): Promise<NotifierActionResult> {
    const cfg = routine();
    if ('problem' in cfg) return { ok: false, detail: cfg.problem, sent: 0, failed: 0 };
    const open = (feed?.waitingOnHuman() ?? []).filter((q) => again || !sent.has(q.id));
    const at = clock.now().toISOString();
    const results = await Promise.all(open.map((q) => sendQuestion(q, at)));
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
    if (now) announce();
    sweep();
  }

  /** Where the hopper is reached, when it is new, back, or due again (issue #795). A failed send waits for the heartbeat. */
  function announce(): void {
    let url: string | undefined;
    try { url = feed?.reach?.(); } catch { url = undefined; }
    if (!url) {
      if (reach.url) reach.down = true;
      reach.url = undefined;
      return;
    }
    const due = Date.now() - reach.at >= heartbeatMs;
    if (reach.sending || (url === reach.url && !due)) return;
    const reason = url === reach.url ? 'heartbeat' : reach.down ? 'recovery' : reach.at === 0 ? 'start' : 'change';
    Object.assign(reach, { url, at: Date.now(), down: false, sending: true });
    track(deliver(`grokbot: hopper.reachable (${reason})`, reachablePayload(url, reason, clock.now().toISOString(), heartbeatMs), { kind: 'hopper.reachable' }).finally(() => { reach.sending = false; }), 'hopper.reachable');
  }

  return {
    name: o.name,
    start(events) {
      feed = events;
      if (events.deliveries) rows = events.deliveries;
      stopping = new AbortController();
      running = true;
      unsubscribe ??= events.subscribe(onEvent);
      // Configured at start: its open questions went out before (a restart sends nothing again).
      configured = !('problem' in routine());
      if (configured) announce();
      timer ??= setInterval(watch, watchMs);
      timer.unref();
      // What a stop left, or a crash: sent now.
      sweep();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
      running = false;
      for (const t of retries) clearTimeout(t);
      retries.clear();
      stopping.abort();
      await Promise.all(inFlight);
      if (!o.outbound) outbound.stop();
    },
    async test() {
      const cfg = routine();
      if ('problem' in cfg) return { ok: false, detail: cfg.problem };
      const body = JSON.stringify(testPayload(clock.now().toISOString()));
      const r = await outbound.send({ sender: 'notifier', name: o.name, url: cfg.url, kind: 'test' }, () => postOnce(cfg.url, cfg.key, body));
      if (r.status === undefined) return { ok: false, detail: r.error ?? 'no answer' };
      const ok = r.status >= 200 && r.status < 300;
      logger.info(`grokbot: ${o.name}: test event: HTTP ${r.status}`);
      return { ok, status: r.status, detail: `HTTP ${r.status}` };
    },
    sendOpen: () => sendOpen(true),
  };
}
