// Component watchers (issue #1077, design.md "Component watchers"): one user's watchers, each checking one component of
// the hopper on its own interval against its source of truth. A check answers the drift it found, by kind. A kind new
// since the check before is one `drift.found`; one gone is one `drift.cleared`. With the user's setting on, each drift
// is one **drift issue** on the hopper's own repository, through the user's own GitHub connection: found again by its
// drift key — kept in memory, else searched for —, updated when what it says changed, never filed twice. A failed check
// keeps the drift as it was and says why. The drift found lives in memory: a restart checks again at once.
import {
  DEFAULT_COMPONENT_WATCHERS, driftIssue, driftKey, type ComponentWatcherSettings, type ComponentWatchersView, type Drift,
} from '../domain/drift.ts';

export type { ComponentWatcherView, ComponentWatchersView, DriftView } from '../domain/drift.ts';
import type { NewEvent } from '../domain/types.ts';
import { REPORT_LABEL } from '../bug-reports/context.ts';
import type { DriftGitHub } from './github.ts';

export type { DriftGitHub } from './github.ts';

/** A watcher of one component: what it checks, against what, how often, and the check. */
export interface ComponentWatcher {
  name: string;
  /** The component, and its source of truth, in plain words. */
  component: string;
  truth: string;
  intervalMs: number;
  /** The instance's, not the user's (the stack): only the hopper's admin reads it. */
  instance?: true;
  check(): Promise<Drift[]>;
}


export interface ComponentWatchers {
  view(): ComponentWatchersView;
  /** Saves the settings; the same value changes nothing and records nothing. */
  change(settings: ComponentWatcherSettings, by: string): Promise<ComponentWatchersView>;
  /** One check of the watcher now; one at a time per watcher. */
  check(name: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

export interface ComponentWatchersOptions {
  watchers: readonly ComponentWatcher[];
  store: {
    events: { append(event: NewEvent): unknown };
    settings: { getComponentWatchers(): ComponentWatcherSettings | undefined; setComponentWatchers(s: ComponentWatcherSettings): void };
  };
  /** The user's own GitHub connection, or why there is none. */
  github(): DriftGitHub | { problem: string };
  now(): string;
  log(line: string): void;
}

interface Found { drift: Drift; since: string; issue?: { number: number; url: string }; sent?: string; clearedAt?: string }
interface State { checkedAt?: string; error?: string; issueError?: string; found: Map<string, Found> }

export function createComponentWatchers(o: ComponentWatchersOptions): ComponentWatchers {
  const settings = (): ComponentWatcherSettings => ({ ...DEFAULT_COMPONENT_WATCHERS, ...o.store.settings.getComponentWatchers() });
  const states = new Map<string, State>(o.watchers.map((w) => [w.name, { found: new Map() }]));
  const running = new Map<string, Promise<void>>();
  const timers: ReturnType<typeof setTimeout>[] = [];

  const textOf = (f: Found) => driftIssue(f.drift, { firstSeen: f.since, ...(f.clearedAt ? { clearedAt: f.clearedAt } : {}) });

  /** The drift's issue says what it says now: found again, filed, or updated; each write one event. */
  async function tell(github: DriftGitHub, f: Found): Promise<void> {
    const text = textOf(f);
    if (f.sent === text.body) return;
    const at = { watcher: f.drift.watcher, kind: f.drift.kind };
    f.issue ??= await github.find(driftKey(f.drift));
    if (f.issue) {
      await github.update(f.issue.number, text);
      o.store.events.append({ type: 'drift.issue_updated', data: { ...at, ...f.issue } });
    } else {
      if (f.drift.items.length === 0) return;
      f.issue = await github.file({ ...text, labels: [REPORT_LABEL] });
      o.store.events.append({ type: 'drift.issue_filed', data: { ...at, ...f.issue } });
    }
    f.sent = text.body;
  }

  async function checkOnce(w: ComponentWatcher, s: State): Promise<void> {
    let drifts: Drift[];
    try {
      drifts = await w.check();
    } catch (e) {
      const error = (e as Error).message;
      if (error !== s.error) o.log(`hopper: component watcher ${w.name}: ${error}`);
      s.error = error;
      return;
    }
    const now = o.now();
    s.checkedAt = now;
    delete s.error;
    const seen = new Set<string>();
    for (const d of drifts.filter((x) => x.items.length > 0)) {
      const key = driftKey(d);
      seen.add(key);
      const f = s.found.get(key);
      if (!f || f.clearedAt) o.store.events.append({ type: 'drift.found', data: { watcher: d.watcher, kind: d.kind, items: d.items.length } });
      if (f) { f.drift = d; delete f.clearedAt; } else s.found.set(key, { drift: d, since: now });
    }
    for (const [key, f] of s.found) {
      if (seen.has(key) || f.clearedAt) continue;
      f.clearedAt = now;
      f.drift = { ...f.drift, items: [] };
      o.store.events.append({ type: 'drift.cleared', data: { watcher: f.drift.watcher, kind: f.drift.kind } });
    }
    const fileIssues = settings().fileIssues;
    if (fileIssues) {
      const github = o.github();
      try {
        if ('problem' in github) throw new Error(github.problem);
        for (const f of s.found.values()) await tell(github, f);
        delete s.issueError;
      } catch (e) {
        const error = (e as Error).message;
        if (error !== s.issueError) o.log(`hopper: component watcher ${w.name}: its drift issue: ${error}`);
        s.issueError = error;
      }
    }
    // A cleared drift is done with once its issue says so, or when it has none to tell.
    for (const [key, f] of s.found) if (f.clearedAt && (!fileIssues || !f.issue || f.sent === textOf(f).body)) s.found.delete(key);
  }

  function check(name: string): Promise<void> {
    const w = o.watchers.find((x) => x.name === name);
    const s = states.get(name);
    if (!w || !s) return Promise.resolve();
    const now = running.get(name);
    if (now) return now;
    const p = checkOnce(w, s).finally(() => running.delete(name));
    running.set(name, p);
    return p;
  }

  const view = (): ComponentWatchersView => ({
    settings: settings(),
    watchers: o.watchers.map((w) => {
      const s = states.get(w.name)!;
      return {
        name: w.name, component: w.component, truth: w.truth, intervalSeconds: Math.round(w.intervalMs / 1000), ...(w.instance ? { instance: w.instance } : {}),
        ...(s.checkedAt ? { checkedAt: s.checkedAt } : {}), ...(s.error ? { error: s.error } : {}), ...(s.issueError ? { issueError: s.issueError } : {}),
        drifts: [...s.found.values()].filter((f) => !f.clearedAt).map((f) => ({
          kind: f.drift.kind, items: f.drift.items.length, list: f.drift.items, since: f.since, ...(f.issue ? { issue: f.issue } : {}),
        })),
      };
    }),
  });

  return {
    view,
    async change(next, by) {
      const from = settings(), to: ComponentWatcherSettings = { fileIssues: next.fileIssues };
      if (from.fileIssues !== to.fileIssues) {
        o.store.settings.setComponentWatchers(to);
        o.store.events.append({ type: 'component_watchers.settings_changed', data: { from, to, by } });
      }
      return view();
    },
    check,
    start() {
      if (timers.length > 0) return;
      for (const w of o.watchers) {
        const run = () => { check(w.name).catch((e: unknown) => o.log(`hopper: component watcher ${w.name}: ${(e as Error).message}`)); };
        const first = setTimeout(run, 0);
        const t = setInterval(run, w.intervalMs);
        first.unref?.();
        t.unref?.();
        timers.push(first, t);
      }
    },
    async stop() {
      for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
      await Promise.all([...running.values()].map((p) => p.catch(() => undefined)));
    },
  };
}
