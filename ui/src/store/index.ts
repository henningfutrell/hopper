// The UI's one store: what the daemon last said, kept current by SSE. Jobs are held once, by id
// (`jobs`); every job view derives from them through `jobBoard` (store/selectors.ts). Reads go through `get`,
// writes through `act` (POST /ui/api/*). Refreshes after events are debounced, so a burst of
// events costs one round of requests.
import { toast } from 'sonner';
import { create } from 'zustand';
import { get, onSessionEnded, post, SessionRejected, clearToken, readSession } from '@/lib/api';
import { beginSignIn, signInThroughGateway, signInWithoutCredential, wantsGatewaySignIn, wantsNoSignIn } from '@/lib/login';
import { reauthFor, rememberReturn, takeReturn } from '@/lib/reauth';
import { rerunOutcome } from '@/model/board';
import { HISTORY_TYPES } from '@/model/event-types';
import { clockOffset } from '@/model/logins';
import { reloadNeeded } from '@/model/update';
import type { BlastRadiusView, FailureSettings, FailuresView, LoginSettings, LoginsRead, LoginView, PriorityLanesView, QuestionView, SessionUser, SessionView } from '@/model/wire';
import { refreshPriorityLanes, refreshPriorityLanesSoon } from './priority-lanes';
import { refreshAllReviews, refreshReviewsSoon } from './reviews';
import { EMPTY_REVIEWS, REVIEW_KINDS, REVIEW_UI, type ReviewState } from '@/model/reviews';
import type { ReviewKind } from '@/model/wire';
import type { Decision, DomainEvent, Health, Job, MachineView, PartAccount, PluginsReport, PreSort, Queue, QueueGate, RoutingReport, SourceStatus, UpdateStatus, UsageReport, WebhookDelivery, WebhookView, WebhooksView } from '@/model/wire';

export const CAP = { events: 500, history: 5000, decisions: 100, deliveries: 100 };
export type Conn = 'connecting' | 'live' | 'reconnecting';

export interface HopperState {
  loaded: boolean;
  loadError: string | null;
  conn: Conn;
  /** The session was read, or could not be: until then the page shows nothing (issue #213). */
  sessionRead: boolean;
  authed: boolean;
  /** Who the session belongs to; null logged out. */
  user: SessionUser | null;
  /** The ways to sign in (GET /ui/api/session); null until read. */
  signIn: SessionView['signIn'] | null;
  health: Health | null;
  /** Every job the daemon's /api/queue holds — not ended, or ended in the last 24 hours — by id. */
  jobs: Record<string, Job>;
  /** The queue order of the waiting jobs, as /api/queue gave it. */
  waitingOrder: string[];
  /** The locked entries, as /api/queue gave them (issue #355): failed jobs of any age, so kept apart from `jobs`. */
  locked: Job[];
  /** The queue gate and the pre-sort of the jobs not yet accepted, as /api/queue gave them (issue #159). */
  gate: QueueGate | null;
  presort: PreSort | null;
  /** The high-priority threshold /api/queue answered (issue #535); null until read: nothing is tagged. */
  highPriority: number | null;
  /** GET /api/priority-lanes (issue #535): the settings, the lanes chosen, every lane's reliability; null until read. */
  priorityLanes: PriorityLanesView | null;
  blastRadius: BlastRadiusView | null; // GET /api/blast-radius (issue #542); null until read
  machines: MachineView[];
  decisions: Decision[];
  /** Open questions, every stage, each with its job's live priority (issue #535). */
  questions: QuestionView[];
  /** The question history: every question no longer open, newest first (GET /api/questions?status=all). */
  handled: QuestionView[];
  /**
   * Each review section (issues #537, #543): its open items — in review or sent back, each with its job's live priority,
   * never in `questions` —, the decided and cancelled ones newest first, its settings and its type, as GET /api/<section>
   * answered them.
   */
  reviews: Readonly<Record<ReviewKind, ReviewState>>;
  /** The logins, newest first (GET /api/logins, issue #477): open and ended; never in `questions`. */
  logins: LoginView[];
  /** The logins settings, as GET /api/logins answered them; null until read. */
  loginSettings: LoginSettings | null;
  /** GET /api/failures (issue #509): hand-offs (issue #516), problems, assessed failures, the profile, the settings; null until read. */
  failures: FailuresView | null;
  /** Server time less the browser's when the logins were read: countdowns run on server time. */
  serverOffsetMs: number;
  /** Newest first, every type: the live log. */
  events: DomainEvent[];
  /** Oldest first, HISTORY_TYPES only: the charts. */
  history: DomainEvent[];
  sources: SourceStatus[];
  deliveries: WebhookDelivery[];
  subscriptions: WebhookView[];
  /** GET /api/plugins, fetched by the Plugins view; `pluginsError` when that failed. */
  plugins: PluginsReport | null;
  pluginsError: string | null;
  /** GET /api/usage: readings, usage source states, limits, lane effect per machine. */
  usage: UsageReport | null;
  /** GET /api/accounts. */
  accounts: PartAccount[];
  /** GET /api/routing, fetched by the Routing view; `routingError` when that failed. */
  routing: RoutingReport | null;
  routingError: string | null;
  /** GET /api/update: self-update (issue #44). */
  update: UpdateStatus | null;
  /** The installed commit when this page loaded: another one later means the daemon restarted on an update. */
  loadedCommit: string | undefined;
  /**
   * How many times the stream said new samples were kept: usage samples (SSE usage.recorded) and machine samples (SSE
   * machine.recorded, issue #560). The usage graphs and the resource graphs read again on each.
   */
  recorded: Readonly<Record<'usage' | 'machine', number>>;
}

export const useHopper = create<HopperState>(() => ({
  loaded: false, loadError: null, conn: 'connecting', sessionRead: false, authed: false, user: null, signIn: null, health: null, jobs: {}, waitingOrder: [], locked: [], gate: null, presort: null, highPriority: null, priorityLanes: null, blastRadius: null, machines: [],
  decisions: [], questions: [], handled: [], reviews: EMPTY_REVIEWS, logins: [], loginSettings: null, failures: null, serverOffsetMs: 0, events: [], history: [], sources: [], deliveries: [], subscriptions: [],
  plugins: null, pluginsError: null, usage: null, accounts: [], routing: null, routingError: null, update: null, loadedCommit: undefined,
  recorded: { usage: 0, machine: 0 },
}));
const set = useHopper.setState;
const state = useHopper.getState;

const capped = <T,>(list: T[], cap: number) => (list.length > cap ? list.slice(0, cap) : list);
const upsert = <T,>(list: T[], item: T, same: (x: T) => boolean, cap: number) =>
  list.some(same) ? list.map((x) => (same(x) ? item : x)) : capped([item, ...list], cap);

/** The one way jobs enter the store: an /api/queue answer replaces them all, with the queue gate and its pre-sort. */
const jobsOf = (q: Queue): Pick<HopperState, 'jobs' | 'waitingOrder' | 'locked' | 'gate' | 'presort' | 'highPriority'> => ({
  jobs: Object.fromEntries([...q.waiting, ...q.waitingAnswer, ...q.operatorLed, ...q.parked, ...q.running, ...q.ended].map((j) => [j.id, j])),
  waitingOrder: q.waiting.map((j) => j.id),
  locked: q.locked,
  gate: q.gate,
  presort: q.presort,
  highPriority: typeof q.highPriority === 'number' ? q.highPriority : null,
});

export async function refreshHealth() { set({ health: await get<Health>('/api/health') }); }
export async function refreshPlugins() {
  try { set({ plugins: await get<PluginsReport>('/api/plugins'), pluginsError: null }); } catch (e) { set({ pluginsError: (e as Error).message }); }
}
/** GET /api/webhooks, or the answer to a webhooks edit: the subscriptions (never a secret) and the file's status. */
export const setWebhooks = (v: WebhooksView) => set({ subscriptions: v.subscriptions });
export async function refreshWebhooks() { setWebhooks(await get<WebhooksView>('/api/webhooks')); }
export const setPlugins = (plugins: PluginsReport) => set({ plugins, pluginsError: null });
export async function refreshRouting() {
  try { set({ routing: await get<RoutingReport>('/api/routing'), routingError: null }); } catch (e) { set({ routingError: (e as Error).message }); }
}
export const setRouting = (routing: RoutingReport) => set({ routing, routingError: null });
export const HANDLED_LIMIT = 200;
const handledOf = (all: QuestionView[]) => all.filter((q) => q.status !== 'open');
export async function refreshQuestions() {
  const [open, all] = await Promise.all([
    get<{ questions: QuestionView[] }>('/api/questions?status=open'), get<{ questions: QuestionView[] }>(`/api/questions?status=all&limit=${HANDLED_LIMIT}`),
  ]);
  set({ questions: open.questions, handled: handledOf(all.questions) });
}
export const LOGINS_LIMIT = 200;
const loginsOf = (r: LoginsRead): Pick<HopperState, 'logins' | 'loginSettings' | 'serverOffsetMs'> =>
  ({ logins: r.logins, loginSettings: r.settings, serverOffsetMs: clockOffset(r.now, Date.now()) });
/** GET /api/logins: the logins, their settings and the server's time (issue #477). An answer without them is refused, never read as none. */
export async function refreshLogins() {
  const r = await get<LoginsRead>(`/api/logins?limit=${LOGINS_LIMIT}`);
  if (!Array.isArray(r.logins) || !r.settings || Number.isNaN(Date.parse(r.now))) throw new Error('GET /api/logins: the answer holds no logins');
  set(loginsOf(r));
}
/** POST /ui/api/logins/settings (admin): either setting, or both. Failures toast; a rejected session drops to the landing page. */
export async function saveLoginSettings(body: Partial<LoginSettings>): Promise<void> {
  try {
    set({ loginSettings: await post<LoginSettings>('/ui/api/logins/settings', body) });
    toast.success('Logins settings saved');
  } catch (e) {
    if (e instanceof SessionRejected) set({ authed: false, user: null });
    toast.error((e as Error).message);
  }
}
/** GET /api/failures (issue #509). An answer without its parts is refused, never read as none. */
export async function refreshFailures() {
  const r = await get<FailuresView>('/api/failures');
  if (!Array.isArray(r.handoffs) || !Array.isArray(r.problems) || !Array.isArray(r.recent) || !r.settings || !r.profile) throw new Error('GET /api/failures: the answer holds no failures');
  set({ failures: r });
}
/** A Failures action (issue #509): the daemon's answer, then the failures read again. Failures toast, as `act`. */
export async function failureAct(path: string, body: unknown, done: string): Promise<boolean> {
  const r = await actFor(path, body, done);
  refreshFailures().catch(() => {});
  return r.ok;
}
/** POST /ui/api/failures/settings (admin). Failures toast; a rejected session drops to the landing page. */
export async function saveFailureSettings(body: Partial<FailureSettings>): Promise<void> {
  try {
    const settings = await post<FailureSettings>('/ui/api/failures/settings', body);
    const f = state().failures;
    if (f) set({ failures: { ...f, settings } });
    toast.success('Failures settings saved');
  } catch (e) {
    if (e instanceof SessionRejected) set({ authed: false, user: null });
    toast.error((e as Error).message);
  }
}
/** The owner has the questions in front of them: mark each seen (POST /ui/api/questions/:id/seen). The nav badge does not read it. Quiet: no toast. */
export async function markSeen(ids: string[]) {
  for (const id of ids) {
    try {
      const q = await post<QuestionView>(`/ui/api/questions/${encodeURIComponent(id)}/seen`);
      set({ questions: state().questions.map((x) => (x.id === q.id ? { ...x, ...q } : x)) });
    } catch (e) {
      if (e instanceof SessionRejected) { set({ authed: false }); return; }
    }
  }
}
/** GET /api/update. The daemon running another commit than this page was loaded from → reload (new UI bundle). */
export async function refreshUpdate() {
  const update = await get<UpdateStatus>('/api/update');
  const { loadedCommit } = state();
  if (reloadNeeded(loadedCommit, update)) { location.reload(); return; }
  set({ update, loadedCommit: loadedCommit ?? update.installed?.commit });
}
/** POST /ui/api/update: check, apply, or settings. Answers the new status; failures toast. */
export async function updateAct(body: { action: 'check' | 'apply' } | { action: 'settings'; channel?: UpdateStatus['channel']; autoUpdate?: boolean }, done?: string) {
  try {
    set({ update: await post<UpdateStatus>('/ui/api/update', body) });
    if (done) toast.success(done);
  } catch (e) {
    if (e instanceof SessionRejected) set({ authed: false });
    toast.error((e as Error).message);
  }
}
export async function refreshLive() {
  const [queue, machines, usage] = await Promise.all([get<Queue>('/api/queue'), get<{ machines: MachineView[] }>('/api/machines'), get<UsageReport>('/api/usage')]);
  set({ ...jobsOf(queue), machines: machines.machines, usage });
}
/** Usage and accounts change without an event (a usage source reads in the background): views poll this. */
export async function refreshUsage() {
  const [usage, accounts] = await Promise.all([get<UsageReport>('/api/usage'), get<{ accounts: PartAccount[] }>('/api/accounts')]);
  set({ usage, accounts: accounts.accounts });
}

function debounced(fn: () => Promise<void>, ms = 150) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return () => { clearTimeout(t); t = setTimeout(() => { fn().catch(() => {}); }, ms); };
}
export const refreshLiveSoon = debounced(refreshLive);
const refreshQuestionsSoon = debounced(refreshQuestions);
const refreshLoginsSoon = debounced(refreshLogins);
const refreshFailuresSoon = debounced(refreshFailures);
/** What the assessor writes, and what changes what it shows (a job run again, a job failed). */
const FAILURE_EVENTS = new Set(['job.assessed', 'failure.grouped', 'failure.resolved', 'handoff.opened', 'handoff.closed', 'job.rerun', 'job.failed', 'job.dismissed']);

export async function checkSession() {
  try {
    let s = await readSession();
    // The sign-in config's `none`: nobody signs in; take the session at once (design.md "Sign-in", issue #53).
    // A gateway realm: the auth gateway in front signed the person in; take the session from its token (issue #215).
    if (wantsGatewaySignIn(s.authenticated, s.signIn) && (await signInThroughGateway()) === null) s = await readSession();
    if (wantsNoSignIn(s.authenticated, s.signIn) && (await signInWithoutCredential()) === null) s = await readSession();
    set({ authed: s.authenticated, user: s.user ?? null, signIn: s.signIn });
    // Signed in again after a session ended (issue #439): back to the page the person was on.
    const back = s.authenticated ? takeReturn() : null;
    if (back && (location.hash === '' || location.hash === '#')) location.hash = back;
  } catch { /* daemon unreachable: the landing page says so */ }
  set({ sessionRead: true });
}

let ending = false;
/**
 * The daemon says the session is over (issue #439): its idle timeout or maximum passed, its realm changed, or
 * the gateway's token no longer checks out. Straight to sign-in with the realm it was made with, keeping the
 * page to come back to; never a page whose calls fail one by one.
 */
export async function sessionEnded(): Promise<void> {
  if (ending) return;
  ending = true;
  const realm = state().user?.realm ?? null;
  rememberReturn(location.hash);
  set({ authed: false, user: null });
  try {
    const offer = (await readSession()).signIn;
    set({ signIn: offer });
    const next = reauthFor(realm, offer);
    if (next.kind === 'redirect') { beginSignIn(next.realm, offer.origin); return; }
    if (next.kind === 'gateway') { location.reload(); return; }
  } catch { /* daemon unreachable: the landing page says so */ }
  ending = false;
}
onSessionEnded(() => { void sessionEnded(); });

/** How often an open page asks whether its session still lives, so one that ended is noticed without a failing call. */
export const SESSION_CHECK_MS = 60_000;
/** Ask now: a session that ended while the page was open goes to sign-in. */
export async function recheckSession(): Promise<void> {
  if (!state().authed || ending) return;
  try {
    const s = await readSession();
    if (!s.authenticated) await sessionEnded();
    else set({ user: s.user ?? null });
  } catch { /* daemon unreachable: the stream says so */ }
}

/** A UI mutation. Failures toast; a rejected session drops to the landing page. Resolves true on success. */
export async function act(path: string, body: unknown = {}, done?: string): Promise<boolean> {
  return (await actFor(path, body, done)).ok;
}

/** `act`, with the failure's reason for a view that shows it in place (issue #459). */
export async function actFor(path: string, body: unknown = {}, done?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await post(path, body);
    if (done) toast.success(done);
    refreshLiveSoon();
    return { ok: true };
  } catch (e) {
    if (e instanceof SessionRejected) set({ authed: false, user: null });
    toast.error((e as Error).message);
    return { ok: false, error: (e as Error).message };
  }
}

/** Run again (issue #354): the answer is the new job, already queued; its toast says where it is. Failures toast their reason. */
export async function rerun(jobId: string): Promise<void> {
  try {
    const out = rerunOutcome(await post<Job>(`/ui/api/jobs/${jobId}/rerun`, {}));
    if (out.ok) toast.success(out.message); else toast.error(out.message);
    refreshLiveSoon();
  } catch (e) {
    if (e instanceof SessionRejected) set({ authed: false, user: null });
    toast.error((e as Error).message);
  }
}

export async function logout() {
  try { await post('/ui/api/logout'); } catch { /* already gone */ }
  clearToken();
  // Drop the work from the page; it comes back as the landing page (issue #213).
  location.reload();
}

export function onDomainEvent(e: DomainEvent) {
  const s = state();
  // The stream sends in seq order, so anything at or below the newest held is a replay.
  if (e.seq <= (s.events[0]?.seq ?? 0)) return;
  set({
    events: capped([e, ...s.events], CAP.events),
    ...(HISTORY_TYPES.includes(e.type) && e.seq > (s.history.at(-1)?.seq ?? 0) ? { history: [...s.history, e].slice(-CAP.history) } : {}),
  });
  refreshLiveSoon();
  if (e.type.startsWith('question.')) refreshQuestionsSoon();
  if (e.type.startsWith('auth.')) refreshLoginsSoon();
  for (const k of REVIEW_KINDS) if (e.type.startsWith(`${REVIEW_UI[k].prefix}.`)) refreshReviewsSoon(k);
  if (FAILURE_EVENTS.has(e.type)) refreshFailuresSoon();
  // A job's priority changed (a label): its question, login and hand-off are tagged and sorted by it (issue #535).
  if (e.type === 'job.reprioritized') { refreshQuestionsSoon(); for (const k of REVIEW_KINDS) refreshReviewsSoon(k); refreshLoginsSoon(); refreshFailuresSoon(); }
  if (e.type.startsWith('priority_lanes.') && s.priorityLanes) refreshPriorityLanesSoon();
  if (e.type === 'priority_lanes.settings_changed') refreshQuestionsSoon();
  if (e.type.startsWith('update.')) refreshUpdate().catch(() => {});
  if (e.type === 'decision.made') {
    const id = e.decisionId ?? String(e.data.decisionId);
    get<Decision>(`/api/decisions/${encodeURIComponent(id)}`).then((d) => {
      const list = state().decisions;
      if (!list.some((x) => x.id === d.id)) set({ decisions: capped([d, ...list], CAP.decisions) });
    }).catch(() => {});
  }
}
export const onDelivery = (d: WebhookDelivery) => set({ deliveries: upsert(state().deliveries, d, (x) => x.id === d.id, CAP.deliveries) });
export const onSource = (src: SourceStatus) => set({ sources: upsert(state().sources, src, (x) => x.name === src.name, Infinity) });
export const onRecorded = (k: 'usage' | 'machine') => set({ recorded: { ...state().recorded, [k]: state().recorded[k] + 1 } });
export const setConn = (conn: Conn) => set({ conn });

/** True when the page must show only the landing page, with the ways to sign in: logged out (issues #167, #213). */
export const mustSignIn = (s: Pick<HopperState, 'authed'>): boolean => !s.authed;

/** Reads everything once. Resolves false, having read no work, when logged out: the page must sign in first. */
export async function load(): Promise<boolean> {
  await checkSession();
  if (mustSignIn(state())) return false;
  const since = encodeURIComponent(HISTORY_TYPES.join(','));
  const [health, queue, machines, decisions, events, history, subs, deliveries, questions, allQuestions, sources, usage, accounts] = await Promise.all([
    get<Health>('/api/health'), get<Queue>('/api/queue'), get<{ machines: MachineView[] }>('/api/machines'),
    get<{ decisions: Decision[] }>('/api/decisions?limit=50'), get<{ events: DomainEvent[] }>('/api/events?limit=200'),
    get<{ events: DomainEvent[] }>(`/api/events?limit=${CAP.history}&types=${since}`),
    get<WebhooksView>('/api/webhooks'),
    get<{ deliveries: WebhookDelivery[] }>('/api/webhooks/deliveries?limit=100'),
    get<{ questions: QuestionView[] }>('/api/questions?status=open'), get<{ questions: QuestionView[] }>(`/api/questions?status=all&limit=${HANDLED_LIMIT}`),
    get<{ sources: SourceStatus[] }>('/api/sources'),
    get<UsageReport>('/api/usage'), get<{ accounts: PartAccount[] }>('/api/accounts'),
  ]);
  set({
    loaded: true, loadError: null, health, ...jobsOf(queue), machines: machines.machines, decisions: decisions.decisions,
    events: events.events.slice().sort((a, b) => b.seq - a.seq), history: history.events.slice().sort((a, b) => a.seq - b.seq),
    subscriptions: subs.subscriptions, deliveries: deliveries.deliveries,
    questions: questions.questions, handled: handledOf(allQuestions.questions), sources: sources.sources, usage, accounts: accounts.accounts,
  });
  refreshUpdate().catch(() => {});
  // Apart, so the server's time is read close to its answer; until it is read the Logins view says so.
  refreshLogins().catch(() => {});
  refreshAllReviews();
  refreshFailures().catch(() => {});
  refreshPriorityLanes().catch(() => {});
  return true;
}
export const setLoadError = (loadError: string) => set({ loadError });
