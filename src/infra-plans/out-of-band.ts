// Out-of-band changes (issue #871, design.md "Out-of-band changes"): one user's infrastructure changes that did not come
// through IaC or GitOps. A job's read-only check reports signals — drift, and audit-log writes —; each is judged by the
// one rule (`judge`): out of band unless a controller identity or a plan-bound apply credential made it. Each out-of-band
// change is kept, an event on the reporting job's timeline that the notifiers send, and waits on Infra changes until a
// person marks it adopted, reverted, or accepted with a reason. Tracking only: the hopper reverts nothing.
import { randomUUID } from 'node:crypto';
import {
  AUDIT_SOURCES, controllerProblem, judge, markProblem, signalProblem, SIGNALS_MAX, type ApplyIdentity, type Mark, type OutOfBandChange,
  type OutOfBandMark, type OutOfBandView, type Signal,
} from '../domain/out-of-band.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import type { PlanRefusal } from './service.ts';

/** What a report came to: the changes kept, the signals in band (with why), and the ones kept already. */
export interface SignalReport {
  recorded: OutOfBandChange[];
  inBand: { source: Signal['source']; key: string; why: string }[];
  known: number;
}

export interface OutOfBandChanges {
  report(job: Job, signals: Signal[]): SignalReport | PlanRefusal;
  list(): OutOfBandView[];
  get(id: string): OutOfBandView | undefined;
  mark(id: string, mark: Mark, reason: string | undefined, by: string): OutOfBandView | PlanRefusal;
  controllers(): string[];
  setControllers(identities: string[], by: string): string[] | PlanRefusal;
}

/** How many changes Infra changes lists. */
const LIST_MAX = 200;
/** How far before a write a mint may be: no minted credential lives longer. */
const MINT_LOOKBACK_MS = 2 * 60 * 60_000;
const CHANGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createOutOfBandChanges(o: { store: Pick<UserStore, 'outOfBand' | 'events' | 'tx'>; clock: Clock }): OutOfBandChanges {
  const repo = o.store.outOfBand;
  /** Every credential the vault minted for an approved plan since `since` (ISO), with who it writes as. */
  const appliesSince = (since: string): ApplyIdentity[] => o.store.events.between(['vault.minted'], since).flatMap((e) => {
    const d = e.data as { plan?: string; principal?: string; job: string; expiresAt: string };
    return d.plan && d.principal ? [{ principal: d.principal, plan: d.plan, job: d.job, from: e.at, until: d.expiresAt }] : [];
  });
  /** A signal seen before: an audit-log write ever kept; drift kept and not yet marked. */
  const known = (s: Signal): boolean => repo.find(s.source, s.key).some((c) => AUDIT_SOURCES.includes(s.source) || !c.marked);
  const viewOf = (c: OutOfBandChange): OutOfBandView => {
    const marked = repo.markOf(c.id);
    return { ...c, ...(marked ? { marked } : {}) };
  };
  return {
    report(job, said) {
      if (said.length === 0 || said.length > SIGNALS_MAX) return { status: 400, no: `a report holds 1 to ${SIGNALS_MAX} signals` };
      for (const [i, s] of said.entries()) {
        const problem = signalProblem(s);
        if (problem) return { status: 400, no: `signal ${i + 1}: ${problem}` };
      }
      // Only the fields a signal has: nothing else a job sends is kept.
      const signals = said.map(({ source, key, target, what, who, at, detail }): Signal => ({
        source, key, target, what, ...(who !== undefined ? { who } : {}), at, ...(detail !== undefined ? { detail } : {}),
      }));
      const earliest = Math.min(...signals.map((s) => Date.parse(s.at)));
      const applies = appliesSince(new Date(earliest - MINT_LOOKBACK_MS).toISOString());
      const controllers = repo.controllers();
      const out: SignalReport = { recorded: [], inBand: [], known: 0 };
      o.store.tx(() => {
        for (const s of signals) {
          const verdict = judge(s, controllers, applies);
          if (!verdict.outOfBand) { out.inBand.push({ source: s.source, key: s.key, why: verdict.why }); continue; }
          if (known(s)) { out.known++; continue; }
          const change: OutOfBandChange = { ...s, id: randomUUID(), job: job.id, recordedAt: o.clock.now().toISOString() };
          repo.add(change);
          o.store.events.append({
            type: 'infra.out_of_band_recorded', jobId: job.id,
            data: {
              change: change.id, source: s.source, key: s.key, target: s.target, what: s.what, ...(s.who ? { who: s.who } : {}), at: s.at, job: job.id,
              ...(job.source?.url ? { issue: job.source.url } : {}),
            },
          });
          out.recorded.push(change);
        }
      });
      return out;
    },
    list: () => repo.list(LIST_MAX),
    get(id) {
      const c = CHANGE_ID.test(id) ? repo.get(id) : undefined;
      return c ? viewOf(c) : undefined;
    },
    mark(id, mark, reason, by) {
      const c = CHANGE_ID.test(id) ? repo.get(id) : undefined;
      if (!c) return { status: 404, no: `no out-of-band change ${id}` };
      const problem = markProblem(mark, reason);
      if (problem) return { status: 400, no: problem };
      if (repo.markOf(id)) return { status: 409, no: `change ${id} is marked already` };
      const m: OutOfBandMark = { change: id, mark, ...(reason?.trim() ? { reason: reason.trim() } : {}), by, at: o.clock.now().toISOString() };
      o.store.tx(() => {
        repo.mark(m);
        o.store.events.append({
          type: 'infra.out_of_band_marked', jobId: c.job,
          data: { change: id, source: c.source, target: c.target, what: c.what, mark, ...(m.reason ? { reason: m.reason } : {}), by },
        });
      });
      return { ...c, marked: m };
    },
    controllers: () => repo.controllers(),
    setControllers(identities, by) {
      const to = [...new Set(identities.map((i) => i.trim()))];
      const problem = controllerProblem(to);
      if (problem) return { status: 400, no: problem };
      const from = repo.controllers();
      if (JSON.stringify(from) === JSON.stringify(to)) return to;
      o.store.tx(() => {
        repo.setControllers(to);
        o.store.events.append({ type: 'infra.controllers_changed', data: { from, to, by } });
      });
      return to;
    },
  };
}
