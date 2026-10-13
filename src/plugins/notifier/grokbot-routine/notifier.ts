// The Grok Bot routine webhook (design.md "Grok Bot routine webhook"): one POST per question that
// reaches the human (`question.escalated_to_human`, issue #481: never a level hop or a re-notification), per stop of intake (issue #358: `source.stalled`, `connected_account.expired`), per new artifact (issue #673: `artifact.created`, with its link), per job end (issue #795: `job.finished`, `job.failed`), and per login a job waits on (issue #698: `auth.pending`, a new code too, and `auth.expired`, never its URL or code), per out-of-band infrastructure change (issue #871: `infra.out_of_band_recorded`), per machine low on free memory and back (issue #868: `machine.memory_low`, `machine.memory_recovered`), per plan of an infrastructure change, its approval and its apply (issue #870 part 4: `infra.plan_recorded`, `infra.plan_approved`, and a `vault.minted` that names a plan and is no renewal, sent as `infra.plan_applied`, each with the watchers of the plan's environments), the URL and key read from the runtime at each use.
// Issue #795: `hopper.reachable` says where the hopper is reached from outside while its tunnel is up — at start, on a new
// URL, on recovery, and on a heartbeat — so the receiver never has to poll for it.
// Issue #378: the questions already open at the human are offered once each when the routine becomes
// configured (a question escalated while it was not is not lost); Send test event and Send open
// questions are the UI's actions. In memory only: no store row, no event.
// Issue #1014: every post passes the routine's outbound guard (a rate limit, a dedupe on the event, a circuit that opens on
// a runaway) and goes into the user's send log (design.md "Outbound sends").
import type { Clock, DomainEvent, Notifier, NotifierActionResult, NotifierEvents, PluginLogger, Question } from '../../sdk.ts';
import { createOutbound, createOutboundGuard, type Outbound, type OutboundRequest } from '../../../outbound/index.ts';
import { artifactPayload, intakePayload, jobPayload, loginPayload, planPayload, questionPayload, reachablePayload, testPayload } from './payload.ts';

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
}

/** What a post is, for the outbound guard: its kind, its job, and the key of the event it is about (none: never a duplicate). */
interface About { kind: string; jobId?: string | undefined; key?: string }

const MAX_ATTEMPTS = 3;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const retriable = (status: number) => status === 429 || status >= 500;
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function wanted(e: DomainEvent): boolean {
  if (e.type === 'source.stalled' || e.type === 'connected_account.expired' || e.type === 'artifact.created' || e.type === 'source.request_opened') return true;
  if (e.type === 'job.finished' || e.type === 'job.failed') return true;
  if (e.type === 'auth.pending' || e.type === 'auth.expired' || e.type === 'infra.out_of_band_recorded') return true;
  if (e.type === 'infra.plan_recorded' || e.type === 'infra.plan_approved') return true;
  if (e.type === 'machine.memory_low' || e.type === 'machine.memory_recovered') return true;
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
  /** Questions sent (or being sent) by this process: an offer skips them. */
  const sent = new Set<string>();
  let unsubscribe: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;
  let configured = false;
  /** The URL last announced (undefined: none since start, or the hopper was not reached since), when, and whether it was down between. */
  const reach: { url?: string | undefined; at: number; down: boolean; sending: boolean } = { at: 0, down: false, sending: false };

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

  /**
   * Deliver with retries; true once a 2xx answered. Nothing is sent while the routine is not configured, nor when the
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
      if (r.status !== undefined && !retriable(r.status)) break;
      if (attempt < MAX_ATTEMPTS) await sleep(baseMs * 2 ** (attempt - 1));
    }
    logger.warn(`${tag}: delivery failed (${last})`);
    return false;
  }

  function sendQuestion(q: Question, offered: boolean, at: string): Promise<boolean> {
    sent.add(q.id);
    const payload = questionPayload({ question: q, job: feed?.job(q.jobId), answerUrl: feed?.answerUrl(q.id), at, now: clock.now(), offered, highPriority: feed?.highPriority?.(), tldr: feed?.tldr?.(q) });
    // An offered question has no key: Send open questions sends again on each press.
    return deliver(`grokbot: question.escalated_to_human ${q.jobId}${offered ? ' (open question)' : ''}`, payload,
      { kind: 'question.escalated_to_human', jobId: q.jobId, ...(offered ? {} : { key: `question:${q.id}` }) });
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
      const about = (kind: string): About => ({ kind, jobId: e.jobId, key: `${e.type}:${e.id}` });
      if (e.type === 'job.finished' || e.type === 'job.failed') return deliver(`grokbot: ${e.type} ${e.jobId ?? ''}`.trim(), jobPayload(e, job), about(e.type));
      if (e.type === 'auth.pending' || e.type === 'auth.expired') return deliver(`grokbot: ${e.type} ${e.jobId ?? ''}`.trim(), loginPayload(e, job, clock.now(), feed?.loginsUrl?.()), about(e.type));
      if (e.type === 'infra.plan_recorded' || e.type === 'infra.plan_approved' || e.type === 'vault.minted') {
        const kind = e.type === 'vault.minted' ? 'infra.plan_applied' : e.type;
        return deliver(`grokbot: ${kind} ${e.jobId ?? ''}`.trim(), planPayload(e, job, feed?.infraPlan?.(String(e.data.plan)), feed?.infraUrl?.()), about(kind));
      }
      if (e.type === 'artifact.created') return deliver(`grokbot: ${e.type} ${e.jobId ?? ''}`.trim(), artifactPayload(e, job, feed?.artifactUrl?.(String(e.data.artifact))), about(e.type));
      if (e.type !== 'question.escalated_to_human') return deliver(`grokbot: ${e.type} ${e.jobId ?? ''}`.trim(), intakePayload(e, job, e.type === 'infra.out_of_band_recorded' ? feed?.infraUrl?.() : undefined), about(e.type));
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
    if (now) announce();
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
      unsubscribe ??= events.subscribe(onEvent);
      // Configured at start: its open questions went out before (a restart sends nothing again).
      configured = !('problem' in routine());
      if (configured) announce();
      timer ??= setInterval(watch, watchMs);
      timer.unref();
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) clearInterval(timer);
      timer = undefined;
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
