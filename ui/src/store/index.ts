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
import { reloadNeeded } from '@/model/update';
import type { SessionUser, SessionView } from '@/model/wire';
import type { Decision, DomainEvent, Health, Job, MachineView, PartAccount, PluginsReport, PreSort, Question, Queue, QueueGate, RoutingReport, SourceStatus, UpdateStatus, UsageReport, WebhookDelivery, WebhookView, WebhooksView } from '@/model/wire';

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
  machines: MachineView[];
  decisions: Decision[];
  /** Open questions, every stage. */
  questions: Question[];
  /** The question history: every question no longer open, newest first (GET /api/questions?status=all). */
  handled: Question[];
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
}

export const useHopper = create<HopperState>(() => ({
  loaded: false, loadError: null, conn: 'connecting', sessionRead: false, authed: false, user: null, signIn: null, health: null, jobs: {}, waitingOrder: [], locked: [], gate: null, presort: null, machines: [],
  decisions: [], questions: [], handled: [], events: [], history: [], sources: [], deliveries: [], subscriptions: [],
  plugins: null, pluginsError: null, usage: null, accounts: [], routing: null, routingError: null, update: null, loadedCommit: undefined,
}));
const set = useHopper.setState;
const state = useHopper.getState;

const capped = <T,>(list: T[], cap: number) => (list.length > cap ? list.slice(0, cap) : list);
const upsert = <T,>(list: T[], item: T, same: (x: T) => boolean, cap: number) =>
  list.some(same) ? list.map((x) => (same(x) ? item : x)) : capped([item, ...list], cap);

/** The one way jobs enter the store: an /api/queue answer replaces them all, with the queue gate and its pre-sort. */
const jobsOf = (q: Queue): Pick<HopperState, 'jobs' | 'waitingOrder' | 'locked' | 'gate' | 'presort'> => ({
  jobs: Object.fromEntries([...q.waiting, ...q.waitingAnswer, ...q.running, ...q.ended].map((j) => [j.id, j])),
  waitingOrder: q.waiting.map((j) => j.id),
  locked: q.locked,
  gate: q.gate,
  presort: q.presort,
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
const handledOf = (all: Question[]) => all.filter((q) => q.status !== 'open');
export async function refreshQuestions() {
  const [open, all] = await Promise.all([
    get<{ questions: Question[] }>('/api/questions?status=open'), get<{ questions: Question[] }>(`/api/questions?status=all&limit=${HANDLED_LIMIT}`),
  ]);
  set({ questions: open.questions, handled: handledOf(all.questions) });
}
/** The owner has the questions in front of them: mark each seen (POST /ui/api/questions/:id/seen). The nav badge does not read it. Quiet: no toast. */
export async function markSeen(ids: string[]) {
  for (const id of ids) {
    try {
      const q = await post<Question>(`/ui/api/questions/${encodeURIComponent(id)}/seen`);
      set({ questions: state().questions.map((x) => (x.id === q.id ? q : x)) });
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
    get<{ questions: Question[] }>('/api/questions?status=open'), get<{ questions: Question[] }>(`/api/questions?status=all&limit=${HANDLED_LIMIT}`),
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
  return true;
}
export const setLoadError = (loadError: string) => set({ loadError });
