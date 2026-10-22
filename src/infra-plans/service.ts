// Infra plans (issue #870, design.md "Infra plans: no apply without a plan"): one user's plans of infrastructure changes.
// A job records a plan; a person approves it; the vault asks the gate before it mints any credential that can change
// infrastructure. Each record and approval is an event on the timeline of the job that recorded the plan. The branch's
// head is read on GitHub at each ask, so a plan made before the code moved is never applied. Approval by risk (part 3):
// an operator approves a low-risk uat plan, or the hopper does when the plan is kept and auto-approve is on; an admin
// approves any other; nobody approves a plan that failed a check. The environment watchers (part 4): who the notifiers
// name for each plan, approval and apply, by the plan's environments; an admin names them. A plan's read credential (part
// 5): the one a plan names is one the vault minted for its job. A person rejects a plan (issue #2368): terminal, with a note;
// it is never approved after, and the gate refuses it.
import { createHash, randomUUID } from 'node:crypto';
import { changesAsset, type Asset, type OperationProfile } from '../domain/access.ts';
import { changesOf } from '../domain/infra-plan-changes.ts';
import { summarize } from '../domain/infra-plan-summary.ts';
import {
  applyRefusal, approveRefusal, approverOf, AUTO_APPROVER, DEFAULT_INFRA_PLAN_SETTINGS, headRefusal, planInputProblem, PLAN_FILE_MAX, PLAN_ID, PLAN_TTL_MINUTES, readProfileOf, readRefusal,
  rejectedWords, REJECTION_NOTE_MAX, type InfraPlan, type InfraPlanSettings, type KeptPlanView, type PlanApply, type PlanApproval, type PlanInput, type PlanView,
} from '../domain/infra-plans.ts';
import { normalWatchers, watchersProblem, type InfraWatchers } from '../domain/infra-watchers.ts';
import type { UiRole } from '../domain/sign-in.ts';
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';

/** A no, with the HTTP status it answers. */
export interface PlanRefusal { status: 400 | 403 | 404 | 409; no: string }
export const isPlanRefusal = (v: unknown): v is PlanRefusal => typeof v === 'object' && v !== null && 'no' in v;

export interface InfraPlans {
  /** Keep a job's plan; with auto-approve on, a plan an operator may approve is approved by the hopper in the same step. */
  record(job: Job, input: PlanInput, file?: Buffer): { plan: InfraPlan; view: PlanView } | PlanRefusal;
  get(id: string): InfraPlan | undefined;
  /** One plan as the hopper shows it, with its text: read off the event loop (issue #2392). */
  view(id: string): Promise<(PlanView & { text: string }) | undefined>;
  file(id: string): Buffer | undefined;
  /** Read off the event loop (issue #2392), as `applies`. */
  list(): Promise<PlanView[]>;
  /** The applies of the plans `list` answers, newest first: each credential the vault minted naming one of them. */
  applies(plans: PlanView[]): Promise<PlanApply[]>;
  approval(id: string): PlanApproval | undefined;
  /** A person of `role` approves the plan: a 403 when its risk needs a higher role (approverOf). */
  approve(id: string, by: string, role: UiRole): PlanView | PlanRefusal;
  /** Issue #2368: a person rejects the plan, with a note: it is never approved after. A 409 once approved or rejected. */
  reject(id: string, by: string, note: string): PlanView | PlanRefusal;
  settings(): InfraPlanSettings;
  setSettings(to: InfraPlanSettings, by: string): InfraPlanSettings;
  watchers(): InfraWatchers;
  /** An admin names the environment watchers: the whole list, kept trimmed (normalWatchers); a 400 that says why. */
  setWatchers(to: InfraWatchers, by: string): InfraWatchers | PlanRefusal;
  /** Why the vault mints nothing for `profile` on `planId`, or undefined: a read, or a current approved plan of the asset. */
  gate(profile: OperationProfile, planId: string | undefined): Promise<string | undefined>;
}

export interface InfraPlansOptions {
  store: Pick<UserStore, 'infraPlans' | 'events' | 'tx' | 'settings' | 'reads'>;
  clock: Clock;
  /** The commit `ref` of `repo` is at now, on GitHub; throws, saying why, when it cannot be read. */
  head(repo: string, ref: string): Promise<string>;
}

/** How many plans Infra lists. */
const LIST_MAX = 200;

export function createInfraPlans(o: InfraPlansOptions): InfraPlans {
  const plans = o.store.infraPlans;
  const withApprover = (p: KeptPlanView): PlanView => ({ ...p, approver: approverOf(p) });
  const viewOf = (p: InfraPlan): PlanView => {
    const { text: _text, ...view } = p;
    const approval = plans.approval(p.id);
    const rejection = plans.rejection(p.id);
    return withApprover({ ...view, ...(approval ? { approval } : {}), ...(rejection ? { rejection } : {}) });
  };
  const settings = (): InfraPlanSettings => o.store.settings.getInfraPlans() ?? DEFAULT_INFRA_PLAN_SETTINGS;
  /** The approval row and its event, in the caller's transaction. */
  const approveNow = (plan: InfraPlan, approval: PlanApproval): void => {
    plans.approve(approval);
    o.store.events.append({
      type: 'infra.plan_approved', jobId: plan.job,
      data: { plan: plan.id, tool: plan.tool, asset: plan.asset, target: plan.target, by: approval.by, ...(approval.auto ? { auto: true } : {}), ...(plan.summary ? { level: plan.summary.level } : {}) },
    });
  };
  /** The read credentials the vault minted for the job (part 5), as a plan names each, each once. */
  const mintedReads = (job: Job): string[] => [...new Set(o.store.events.between(['vault.minted'], job.createdAt).flatMap((e) => {
    const d = e.data as { job?: string; operation?: string; asset?: Asset };
    return e.jobId === job.id && d.operation === 'read' && d.asset ? [readProfileOf(d.asset)] : [];
  }))];
  return {
    record(job, input, file) {
      const problem = planInputProblem(input);
      if (problem) return { status: 400, no: problem };
      if (file && (file.length === 0 || file.length > PLAN_FILE_MAX)) return { status: 400, no: `the plan file must be 1 to ${PLAN_FILE_MAX} bytes` };
      const unminted = readRefusal(input.read, input.read === undefined ? [] : mintedReads(job));
      if (unminted) return { status: 400, no: unminted };
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
        // Auto-approve: still an approval of its own and an event, so the plan shows in the feed and nothing is silent.
        if (settings().autoApprove && approverOf(plan).who === 'operator') approveNow(plan, { plan: plan.id, by: AUTO_APPROVER, at: now.toISOString(), auto: true });
      });
      return { plan, view: viewOf(plan) };
    },
    get: (id) => (PLAN_ID.test(id) ? plans.get(id) : undefined),
    async view(id) {
      const plan = PLAN_ID.test(id) ? await o.store.reads.infraPlan(id) : undefined;
      return plan ? { ...withApprover(plan), text: plan.text } : undefined;
    },
    file: (id) => (PLAN_ID.test(id) ? plans.file(id) : undefined),
    list: async () => (await o.store.reads.infraPlans(LIST_MAX)).map(withApprover),
    async applies(listed) {
      if (listed.length === 0) return [];
      const ids = new Set(listed.map((p) => p.id));
      const since = listed.reduce((min, p) => (p.createdAt < min ? p.createdAt : min), listed[0]!.createdAt);
      return (await o.store.reads.eventsBetween(['vault.minted'], since)).flatMap((e): PlanApply[] => {
        const d = e.data as { plan?: string; operation: string; asset: PlanApply['asset']; job: string; expiresAt: string; renewal?: boolean; actions?: PlanApply['actions'] };
        return d.plan && ids.has(d.plan) ? [{ plan: d.plan, at: e.at, operation: d.operation, asset: d.asset, job: d.job, expiresAt: d.expiresAt, renewal: d.renewal === true, ...(d.actions?.length ? { actions: d.actions } : {}) }] : [];
      }).reverse();
    },
    approval: (id) => plans.approval(id),
    approve(id, by, role) {
      const plan = PLAN_ID.test(id) ? plans.get(id) : undefined;
      if (!plan) return { status: 404, no: `no plan ${id}` };
      // In the tx: a rejection (issue #2368) or an approval kept meanwhile is read with the approval's own write.
      const refused = o.store.tx((): PlanRefusal | undefined => {
        const rejected = plans.rejection(id);
        if (rejected) return { status: 409, no: rejectedWords(id, rejected) };
        if (plans.approval(id)) return { status: 409, no: `plan ${id} is approved already` };
        const no = approveRefusal(plan, role);
        if (no) return { status: approverOf(plan).who === 'nobody' ? 409 : 403, no };
        approveNow(plan, { plan: id, by, at: o.clock.now().toISOString() });
        return undefined;
      });
      return refused ?? viewOf(plan);
    },
    reject(id, by, said) {
      const plan = PLAN_ID.test(id) ? plans.get(id) : undefined;
      if (!plan) return { status: 404, no: `no plan ${id}` };
      const note = said.trim();
      if (!note || note.length > REJECTION_NOTE_MAX) return { status: 400, no: `note must say why the plan is rejected, in 1 to ${REJECTION_NOTE_MAX} characters` };
      const late = o.store.tx(() => {
        const rejected = plans.rejection(id);
        if (rejected) return `plan ${id} is rejected already, by ${rejected.by}`;
        if (plans.approval(id)) return `plan ${id} is approved already: a plan is rejected only before it is approved`;
        plans.reject({ plan: id, by, at: o.clock.now().toISOString(), note });
        o.store.events.append({ type: 'infra.plan_rejected', jobId: plan.job, data: { plan: id, tool: plan.tool, asset: plan.asset, target: plan.target, by, note } });
        return undefined;
      });
      return late ? { status: 409, no: late } : viewOf(plan);
    },
    settings,
    setSettings(to, by) {
      o.store.tx(() => {
        const from = settings();
        if (from.autoApprove === to.autoApprove) return;
        o.store.settings.setInfraPlans(to);
        o.store.events.append({ type: 'infra.settings_changed', data: { from, to, by } });
      });
      return settings();
    },
    watchers: () => o.store.settings.getInfraWatchers() ?? {},
    setWatchers(said, by) {
      const problem = watchersProblem(said);
      if (problem) return { status: 400, no: problem };
      const to = normalWatchers(said);
      o.store.tx(() => {
        const from = o.store.settings.getInfraWatchers() ?? {};
        if (JSON.stringify(from) === JSON.stringify(to)) return;
        o.store.settings.setInfraWatchers(to);
        o.store.events.append({ type: 'infra.watchers_changed', data: { from, to, by } });
      });
      return to;
    },
    async gate(profile, planId) {
      const plan = planId !== undefined && PLAN_ID.test(planId) ? plans.get(planId) : undefined;
      const rejected = plan && changesAsset(profile) ? plans.rejection(plan.id) : undefined;
      if (rejected) return rejectedWords(plan!.id, rejected);
      const no = applyRefusal(profile, planId, plan, plan ? plans.approval(plan.id) : undefined, o.clock.now());
      if (no || !changesAsset(profile) || !plan) return no;
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
