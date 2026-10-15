// Reads of the daemon that the nav, Needs you and the header share (issue #897): the pull requests, the infra plans, the
// out-of-band changes (issue #871), yolo mode, and the header badges (issue #1181). Each path is read once when first used, again every POLL_MS while anything shows it, and again after an event
// whose type starts with one of the given prefixes. A failed read keeps the last answer; until one comes, there is none.
import { useEffect } from 'react';
import { create } from 'zustand';
import { get } from '@/lib/api';
import type { HeaderBadgeSettings, LandingBatchesView, OutOfBandView, PlanView, PullRequestsView, ToolAccountsReport, YoloModeView } from '@/model/wire';
import { useHopper } from './index';

const POLL_MS = 30_000;

const usePolledStore = create<Record<string, unknown>>(() => ({}));

/** Keeps an answer a page got by itself (a save, its own read), so the shared one is not older than what it shows. */
export const setPolled = (path: string, v: unknown): void => usePolledStore.setState({ [path]: v });

const read = (path: string): void => { get<unknown>(path).then((v) => setPolled(path, v), () => {}); };

const users = new Map<string, { n: number; timer: ReturnType<typeof setInterval> }>();

const NO_EVENTS: readonly string[] = [];

function usePolled<T>(path: string, events: readonly string[] = NO_EVENTS): T | undefined {
  const authed = useHopper((s) => s.authed);
  const lastChange = useHopper((s) => s.events.find((e) => events.some((p) => e.type.startsWith(p)))?.id);
  useEffect(() => {
    if (!authed) return undefined;
    let u = users.get(path);
    if (!u) { read(path); u = { n: 0, timer: setInterval(() => read(path), POLL_MS) }; users.set(path, u); }
    const mine = u;
    mine.n += 1;
    return () => { mine.n -= 1; if (mine.n === 0) { clearInterval(mine.timer); users.delete(path); } };
  }, [path, authed]);
  // An event that changes the answer reads it again; the first render reads it above.
  useEffect(() => { if (authed && lastChange !== undefined) read(path); }, [path, authed, lastChange]);
  return usePolledStore((s) => s[path]) as T | undefined;
}

/** The shared reads, each with the events after which it is read again; a plan is recorded with no event. */
export const usePullRequestsView = (): PullRequestsView | undefined => usePolled('/api/pull-requests', ['job.pull_request_', 'yolo_mode.']);
export const useInfraPlans = (): { plans: PlanView[] } | undefined => usePolled('/api/infra-plans');
export const useOutOfBand = (): { changes: OutOfBandView[] } | undefined => usePolled('/api/out-of-band', ['infra.out_of_band_']);
export const useYoloMode = (): YoloModeView | undefined => usePolled('/api/yolo-mode', ['yolo_mode.']);
/** The landing batches (issue #1333): Needs you's stuck landing passes. What is stuck is found by the pass, with no event: polled. */
export const useLandingBatches = (): LandingBatchesView | undefined => usePolled('/api/landing-batches', ['landing_batch.']);
/** The tool accounts (issue #1128): the Accounts view and its badge. A usage source reads with no event: polled only. */
export const useToolAccounts = (): ToolAccountsReport | undefined => usePolled('/api/tool-accounts');
/** The header badges the user chose (issue #1181): saved with no event, so a save keeps its answer (`setPolled`). */
export const HEADER_BADGES_PATH = '/api/header-badges';
export const useHeaderBadges = (): HeaderBadgeSettings | undefined => usePolled(HEADER_BADGES_PATH);
