// Infra plans (issue #870, design.md "Infra plans: no apply without a plan"): one user's plans of infrastructure changes.
// A job records a plan; a person approves it; the vault asks the gate before it mints any credential that can change
// infrastructure. Each record and approval is an event on the timeline of the job that recorded the plan. The branch's
// head is read on GitHub at each ask, so a plan made before the code moved is never applied.
import { createHash, randomUUID } from 'node:crypto';
import type { OperationProfile } from '../domain/access.ts';
import { changesOf } from '../domain/infra-plan-changes.ts';
import { summarize } from '../domain/infra-plan-summary.ts';
import {
  applyRefusal, failedChecks, headRefusal, planInputProblem, PLAN_FILE_MAX, PLAN_ID, PLAN_TTL_MINUTES, type InfraPlan, type PlanApply, type PlanApproval, type PlanInput, type PlanView,
} from '../domain/infra-plans.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

/** A no, with the HTTP status it answers. */
export interface PlanRefusal { status: 400 | 404 | 409; no: string }
export const isPlanRefusal = (v: unknown): v is PlanRefusal => typeof v === 'object' && v !== null && 'no' in v;

export interface InfraPlans {
  record(job: Job, input: PlanInput, file?: Buffer): InfraPlan | PlanRefusal;
  get(id: string): InfraPlan | undefined;
  file(id: string): Buffer | undefined;
  list(): PlanView[];
  /** The applies of the plans `list` answers, newest first: each credential the vault minted naming one of them. */
  applies(plans: PlanView[]): PlanApply[];
  approval(id: string): PlanApproval | undefined;
  approve(id: string, by: string): PlanView | PlanRefusal;
  /** Why the vault mints nothing for `profile` on `planId`, or undefined: a read, or a current approved plan of the asset. */
  gate(profile: OperationProfile, planId: string | undefined): Promise<string | undefined>;
}

export interface InfraPlansOptions {
  store: Pick<UserStore, 'infraPlans' | 'events' | 'tx'>;
  clock: Clock;
  /** The commit `ref` of `repo` is at now, on GitHub; throws, saying why, when it cannot be read. */
  head(repo: string, ref: string): Promise<string>;
}

/** How many plans Infra lists. */
const LIST_MAX = 200;

export function createInfraPlans(o: InfraPlansOptions): InfraPlans {
  const plans = o.store.infraPlans;
  const viewOf = (p: InfraPlan): PlanView => {
    const { text: _text, ...view } = p;
    const approval = plans.approval(p.id);
    return { ...view, ...(approval ? { approval } : {}) };
  };
  return {
    record(job, input, file) {
      const problem = planInputProblem(input);
      if (problem) return { status: 400, no: problem };
      if (file && (file.length === 0 || file.length > PLAN_FILE_MAX)) return { status: 400, no: `the plan file must be 1 to ${PLAN_FILE_MAX} bytes` };
      const changes = changesOf(input.tool, input.text, input.json);
      if (typeof changes === 'string') return { status: 400, no: changes };
      const { json: _json, ...said } = input;
      const target = input.target.trim();
      const summary = summarize(input.tool, changes, { target, asset: input.asset });
      const now = o.clock.now();
      const plan: InfraPlan = {
        id: randomUUID(), ...said, target, summary, job: job.id, ...(job.source?.url ? { issue: job.source.url } : {}),
        ...(file ? { file: { size: file.length, sha256: createHash('sha256').update(file).digest('hex') } } : {}),
        createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + PLAN_TTL_MINUTES * 60_000).toISOString(),
      };
      o.store.tx(() => {
        plans.add(plan, file);
        o.store.events.append({
          type: 'infra.plan_recorded', jobId: job.id,
          data: {
            plan: plan.id, tool: plan.tool, asset: plan.asset, target: plan.target, repo: plan.repo, ref: plan.ref, commit: plan.commit,
            ...(plan.pullRequest !== undefined ? { pullRequest: plan.pullRequest } : {}), ...(plan.read ? { read: plan.read } : {}),
            ...(plan.issue ? { issue: plan.issue } : {}), file: file !== undefined, expiresAt: plan.expiresAt,
            summary: { words: summary.words, level: summary.level, risks: summary.risks.map((r) => r.risk), failed: summary.failed },
          },
        });
      });
      return plan;
    },
    get: (id) => (PLAN_ID.test(id) ? plans.get(id) : undefined),
    file: (id) => (PLAN_ID.test(id) ? plans.file(id) : undefined),
    list: () => plans.list(LIST_MAX),
    applies(listed) {
      if (listed.length === 0) return [];
      const ids = new Set(listed.map((p) => p.id));
      const since = listed.reduce((min, p) => (p.createdAt < min ? p.createdAt : min), listed[0]!.createdAt);
      return o.store.events.between(['vault.minted'], since).flatMap((e): PlanApply[] => {
        const d = e.data as { plan?: string; operation: string; asset: PlanApply['asset']; job: string; expiresAt: string; renewal?: boolean };
        return d.plan && ids.has(d.plan) ? [{ plan: d.plan, at: e.at, operation: d.operation, asset: d.asset, job: d.job, expiresAt: d.expiresAt, renewal: d.renewal === true }] : [];
      }).reverse();
    },
    approval: (id) => plans.approval(id),
    approve(id, by) {
      const plan = PLAN_ID.test(id) ? plans.get(id) : undefined;
      if (!plan) return { status: 404, no: `no plan ${id}` };
      if (plans.approval(id)) return { status: 409, no: `plan ${id} is approved already` };
      const failed = failedChecks(plan);
      if (failed) return { status: 409, no: `plan ${id} failed its checks, so nobody approves it: ${failed}` };
      o.store.tx(() => {
        plans.approve({ plan: id, by, at: o.clock.now().toISOString() });
        o.store.events.append({ type: 'infra.plan_approved', jobId: plan.job, data: { plan: id, tool: plan.tool, asset: plan.asset, target: plan.target, by } });
      });
      return viewOf(plan);
    },
    async gate(profile, planId) {
      const plan = planId !== undefined && PLAN_ID.test(planId) ? plans.get(planId) : undefined;
      const no = applyRefusal(profile, planId, plan, plan ? plans.approval(plan.id) : undefined, o.clock.now());
      if (no || profile.operation === 'read' || !plan) return no;
      let head: string;
      try {
        head = await o.head(plan.repo, plan.ref);
      } catch (e) {
        return `the head of ${plan.repo} ${plan.ref} cannot be read on GitHub, so plan ${plan.id} cannot be checked against it: ${(e as Error).message}`;
      }
      return headRefusal(plan, head);
    },
  };
}
