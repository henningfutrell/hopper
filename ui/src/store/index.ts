// The UI's one store: what the daemon last said, kept current by SSE. Reads go through `get`,
// writes through `act` (POST /ui/api/*). Refreshes after events are debounced, so a burst of
// events costs one round of requests.
import { toast } from 'sonner';
import { create } from 'zustand';
import { get, post, SessionRejected, clearToken, sessionIsLive } from '@/lib/api';
import { HISTORY_TYPES } from '@/model/event-types';
import { reloadNeeded } from '@/model/update';
import type { Decision, DomainEvent, Health, MachineView, PartAccount, PluginsReport, Question, Queue, RoutingReport, SourceStatus, UpdateStatus, UsageReport, WebhookConfig, WebhookDelivery, WebhookView, WebhooksView } from '@/model/wire';

export const CAP = { events: 500, history: 5000, decisions: 100, deliveries: 100 };
export type Conn = 'connecting' | 'live' | 'reconnecting';

export interface HopperState {
  loaded: boolean;
  loadError: string | null;
  conn: Conn;
  authed: boolean;
  health: Health | null;
  queue: Queue;
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
  webhookConfig: WebhookConfig | null;
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

const EMPTY_QUEUE: Queue = { waiting: [], running: [], waitingAnswer: [], ended: [], counts: {} };

export const useHopper = create<HopperState>(() => ({
  loaded: false, loadError: null, conn: 'connecting', authed: false, health: null, queue: EMPTY_QUEUE, machines: [],
  decisions: [], questions: [], handled: [], events: [], history: [], sources: [], deliveries: [], subscriptions: [], webhookConfig: null,
  plugins: null, pluginsError: null, usage: null, accounts: [], routing: null, routingError: null, update: null, loadedCommit: undefined,
}));
const set = useHopper.setState;
const state = useHopper.getState;

const capped = <T,>(list: T[], cap: number) => (list.length > cap ? list.slice(0, cap) : list);
const upsert = <T,>(list: T[], item: T, same: (x: T) => boolean, cap: number) =>
  list.some(same) ? list.map((x) => (same(x) ? item : x)) : capped([item, ...list], cap);

export async function refreshHealth() { set({ health: await get<Health>('/api/health') }); }
export async function refreshPlugins() {
  try { set({ plugins: await get<PluginsReport>('/api/plugins'), pluginsError: null }); } catch (e) { set({ pluginsError: (e as Error).message }); }
}
/** GET /api/webhooks, or the answer to a webhooks edit: the subscriptions (never a secret) and the file's status. */
export const setWebhooks = (v: WebhooksView) => set({ subscriptions: v.subscriptions, webhookConfig: v.config ?? null });
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
/** The owner has the questions in front of them: mark each seen (POST /ui/api/questions/:id/seen), which clears the nav badge. Quiet: no toast. */
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
  set({ queue, machines: machines.machines, usage });
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
  try { set({ authed: await sessionIsLive() }); } catch { /* daemon unreachable: keep the current mode */ }
}

/** A UI mutation. Failures toast; a rejected session drops to read-only. Resolves true on success. */
export async function act(path: string, body: unknown = {}, done?: string): Promise<boolean> {
  try {
    await post(path, body);
    if (done) toast.success(done);
    refreshLiveSoon();
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) set({ authed: false });
    toast.error((e as Error).message);
    return false;
  }
}

export async function logout() {
  try { await post('/ui/api/logout'); } catch { /* already gone */ }
  clearToken();
  set({ authed: false });
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
  if (e.type === 'router.mode_changed') refreshHealth().catch(() => {});
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

export async function load() {
  await checkSession();
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
    loaded: true, loadError: null, health, queue, machines: machines.machines, decisions: decisions.decisions,
    events: events.events.slice().sort((a, b) => b.seq - a.seq), history: history.events.slice().sort((a, b) => a.seq - b.seq),
    subscriptions: subs.subscriptions, webhookConfig: subs.config ?? null, deliveries: deliveries.deliveries,
    questions: questions.questions, handled: handledOf(allQuestions.questions), sources: sources.sources, usage, accounts: accounts.accounts,
  });
  refreshUpdate().catch(() => {});
}
export const setLoadError = (loadError: string) => set({ loadError });
