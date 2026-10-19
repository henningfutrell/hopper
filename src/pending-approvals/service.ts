// Pending approvals (issue #2088, design.md "Pending approvals"): one user's GitHub Actions runs that wait for a
// deployment approval the user can give, across the intake orgs of each connected account (the owners of its job
// repositories), with that account's own connection. The view answers from what the last read found and never reads
// GitHub. GitHub is read in the background on the schedule (`tick`, every `TICK_MS`, the first a tick after the start, then once
// the last read is `FRESH_MS` old); one read at a time, a tick while one runs joins it. Each read is conditional (conditional.ts), with the answers
// kept from the read before, so an unchanged repository costs no call. What was read is kept in memory only: it is a
// copy of GitHub, read again after a restart. A failed read of an account keeps what it read before, with why.
// Read-only: nothing here approves, rejects or records anything.
import { intakeOrgs, markStale, type KeptAnswer, type PendingApproval, type PendingApprovalsProblem, type PendingApprovalsView } from '../domain/types.ts';
import { conditionalAnswers } from '../repo-checks/conditional.ts';
import type { ApprovalsGitHub } from './github.ts';

/** The schedule reads again once the last read is this old: 5 minutes. */
export const FRESH_MS = 5 * 60_000;
/** How often the schedule looks whether a read is due. */
export const TICK_MS = 60_000;

/** A connected account's connection and its job repositories; or why it has none. */
export type ApprovalsSource = { account: string; api: ApprovalsGitHub; repos: readonly string[] } | { account: string; problem: string };

export interface PendingApprovalsOptions {
  sources(): ApprovalsSource[];
  now(): number;
  log(line: string): void;
  tickMs?: number;
}

export interface PendingApprovals {
  /** What the last read found: never reads GitHub. */
  view(): PendingApprovalsView;
  /** The schedule's pass: reads when the last read is `FRESH_MS` old, or joins the read under way. */
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

type Found = { approvals: Omit<PendingApproval, 'stale'>[]; problems: PendingApprovalsProblem[] };

export function createPendingApprovals(o: PendingApprovalsOptions): PendingApprovals {
  /** Each account's last read, and the answers it kept. */
  const found = new Map<string, Found>();
  const kept = new Map<string, Record<string, KeptAnswer>>();
  let checkedAt: number | undefined;
  let reading: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const orgsOf = (s: ApprovalsSource): string[] => ('repos' in s ? intakeOrgs(s.repos) : []);

  async function readAccount(s: ApprovalsSource): Promise<void> {
    if ('problem' in s) { found.set(s.account, { approvals: [], problems: [{ where: s.account, error: s.problem }] }); return; }
    const orgs = orgsOf(s);
    if (orgs.length === 0) { found.delete(s.account); kept.delete(s.account); return; }
    const answers = conditionalAnswers(kept.get(s.account));
    try {
      found.set(s.account, await s.api.waiting(orgs, answers));
      kept.set(s.account, answers.kept());
    } catch (e) {
      const error = (e as Error).message;
      o.log(`hopper: pending approvals of ${s.account}: ${error}`);
      found.set(s.account, { approvals: found.get(s.account)?.approvals ?? [], problems: [{ where: s.account, error }] });
    }
  }

  async function read(): Promise<void> {
    const sources = o.sources();
    const accounts = new Set(sources.map((s) => s.account));
    for (const a of [...found.keys()]) if (!accounts.has(a)) { found.delete(a); kept.delete(a); }
    await Promise.all(sources.map(readAccount));
    checkedAt = o.now();
  }

  const tick = (): Promise<void> => {
    if (reading) return reading;
    if (checkedAt !== undefined && o.now() - checkedAt < FRESH_MS) return Promise.resolve();
    reading = read().catch((e: unknown) => { o.log(`hopper: pending approvals: ${(e as Error).message}`); }).finally(() => { reading = undefined; });
    return reading;
  };

  return {
    view() {
      // A run two accounts reach is one row.
      const rows = new Map<string, Omit<PendingApproval, 'stale'>>();
      for (const f of found.values()) for (const a of f.approvals) { const k = `${a.repo.toLowerCase()} ${a.runId}`; if (!rows.has(k)) rows.set(k, a); }
      return {
        approvals: markStale([...rows.values()]),
        orgs: intakeOrgs(o.sources().flatMap(orgsOf)),
        problems: [...found.values()].flatMap((f) => f.problems),
        ...(checkedAt !== undefined ? { checkedAt: new Date(checkedAt).toISOString() } : {}),
        ...(reading ? { reading: true as const } : {}),
      };
    },
    tick,
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, o.tickMs ?? TICK_MS);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await reading;
    },
  };
}
