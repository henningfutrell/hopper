// The UI's one store: what the daemon last said, kept current by SSE. Reads go through `get`,
// writes through `act` (POST /ui/api/*). Refreshes after events are debounced, so a burst of
// events costs one round of requests.
import { toast } from 'sonner';
import { create } from 'zustand';
import { get, post, SessionRejected, clearToken, sessionIsLive } from '@/lib/api';
import { HISTORY_TYPES } from '@/model/event-types';
import type { Decision, DomainEvent, Health, MachineView, PluginsReport, Question, Queue, SourceStatus, WebhookConfig, WebhookDelivery, WebhookSubscription } from '@/model/wire';

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
  questions: Question[];
  /** Newest first, every type: the live log. */
  events: DomainEvent[];
  /** Oldest first, HISTORY_TYPES only: the charts. */
  history: DomainEvent[];
  sources: SourceStatus[];
  deliveries: WebhookDelivery[];
  subscriptions: WebhookSubscription[];
  webhookConfig: WebhookConfig | null;
  /** GET /api/plugins, fetched by the Plugins view; `pluginsError` when that failed. */
  plugins: PluginsReport | null;
  pluginsError: string | null;
}

const EMPTY_QUEUE: Queue = { waiting: [], running: [], waitingAnswer: [], ended: [], counts: {} };

export const useHopper = create<HopperState>(() => ({
  loaded: false, loadError: null, conn: 'connecting', authed: false, health: null, queue: EMPTY_QUEUE, machines: [],
  decisions: [], questions: [], events: [], history: [], sources: [], deliveries: [], subscriptions: [], webhookConfig: null,
  plugins: null, pluginsError: null,
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
export const setPlugins = (plugins: PluginsReport) => set({ plugins, pluginsError: null });
export async function refreshQuestions() { set({ questions: (await get<{ questions: Question[] }>('/api/questions?status=open')).questions }); }
export async function refreshLive() {
  const [queue, machines] = await Promise.all([get<Queue>('/api/queue'), get<{ machines: MachineView[] }>('/api/machines')]);
  set({ queue, machines: machines.machines });
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
  if (s.events.some((x) => x.seq === e.seq)) return;
  set({
    events: capped([e, ...s.events], CAP.events),
    ...(HISTORY_TYPES.includes(e.type) ? { history: [...s.history, e].slice(-CAP.history) } : {}),
  });
  refreshLiveSoon();
  if (e.type.startsWith('question.')) refreshQuestionsSoon();
  if (e.type === 'router.mode_changed') refreshHealth().catch(() => {});
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
  const [health, queue, machines, decisions, events, history, subs, deliveries, questions, sources] = await Promise.all([
    get<Health>('/api/health'), get<Queue>('/api/queue'), get<{ machines: MachineView[] }>('/api/machines'),
    get<{ decisions: Decision[] }>('/api/decisions?limit=50'), get<{ events: DomainEvent[] }>('/api/events?limit=200'),
    get<{ events: DomainEvent[] }>(`/api/events?limit=${CAP.history}&types=${since}`),
    get<{ subscriptions: WebhookSubscription[]; config?: WebhookConfig }>('/api/webhooks'),
    get<{ deliveries: WebhookDelivery[] }>('/api/webhooks/deliveries?limit=100'),
    get<{ questions: Question[] }>('/api/questions?status=open'), get<{ sources: SourceStatus[] }>('/api/sources'),
  ]);
  set({
    loaded: true, loadError: null, health, queue, machines: machines.machines, decisions: decisions.decisions,
    events: events.events.slice().sort((a, b) => b.seq - a.seq), history: history.events.slice().sort((a, b) => a.seq - b.seq),
    subscriptions: subs.subscriptions, webhookConfig: subs.config ?? null, deliveries: deliveries.deliveries,
    questions: questions.questions, sources: sources.sources,
  });
}
export const setLoadError = (loadError: string) => set({ loadError });
