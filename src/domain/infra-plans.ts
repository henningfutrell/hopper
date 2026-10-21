// Infra plans (issue #870, design.md "Infra plans: no apply without a plan"): a plan of an infrastructure change — a
// `terraform plan` (its text and its saved plan file), a `helm diff`, a GitOps diff — kept as its own record, apart from
// artifacts, and never changed once kept. The vault mints a credential that can change infrastructure (any operation but
// `read`) only for an apply that names a plan of the same asset, made at the commit its branch is at now, not stale, and
// approved by a person. The types, the limits, the checks and the repository port. Pure.
import { changesAsset, profileProblem, type Asset, type OperationProfile } from './access.ts';
import type { PlanRisk, PlanSummary } from './infra-plan-summary.ts';
import { roleAllows, type UiRole } from './sign-in.ts';
import { ACTION_ROLE, profileInWords } from './minting.ts';

/** What made the plan: `terraform plan -out`, `helm diff`, or a GitOps (Argo CD) diff. */
export const PLAN_TOOLS = ['terraform', 'helm', 'gitops'] as const;
export type PlanTool = (typeof PLAN_TOOLS)[number];

/** How long a plan may be applied after it was made: after this it is stale, and the job plans again. */
export const PLAN_TTL_MINUTES = 60;
/** The most text a plan keeps (its `terraform show` text, the diff), and the most bytes of a saved plan file. */
export const PLAN_TEXT_MAX = 1024 * 1024;
export const PLAN_FILE_MAX = 8 * 1024 * 1024;
/** The most bytes of `terraform show -json`: it holds the state before and after, so it is larger than the text. */
export const PLAN_JSON_MAX = 8 * 1024 * 1024;

/** A commit as git names it in full: 40 hex (SHA-1) or 64 (SHA-256). */
export const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
/** `owner/name`, as GitHub names a repository. */
export const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** A branch name git takes, short enough for a row; no `..`, no space, no control character. */
const REF = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._/+-]{1,200}$/;
/** A plan's id: a UUID the hopper makes. */
export const PLAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a job says about a plan when it records one. */
export interface PlanInput {
  tool: PlanTool;
  /** The asset the apply mints a credential for: an `aws-role`, a `cluster`, a `namespace`, an `argocd-app` (a gitops plan's sync). */
  asset: Asset;
  /** The workspace or app the plan changes, in the tool's words (`uat-network`, `argocd app web`). */
  target: string;
  repo: string;
  /** The branch the plan was made from: its head must still be `commit` when the plan is applied. */
  ref: string;
  commit: string;
  pullRequest?: number;
  /** The read credential the plan was made with, as an operation profile (`read/aws-role/123456789012/ReadOnly`). */
  read?: string;
  /** The plan as text: `terraform show` of the plan file, the diff. */
  text: string;
  /** Terraform only, and needed there: `terraform show -json` of the plan file, read into the summary, not kept. */
  json?: string;
}

/** A kept plan: what the job said, who made it, when, and when it goes stale. Never changed once kept. */
export interface InfraPlan extends Omit<PlanInput, 'asset' | 'json'> {
  id: string;
  /** What it changes in plain words, its risks and checks (infra-plan-summary.ts). Absent on a plan kept before. */
  summary?: PlanSummary;
  asset: Asset;
  /** The saved plan file (`terraform plan -out`): its size and SHA-256; its bytes are kept beside the plan. */
  file?: { size: number; sha256: string };
  job: string;
  /** The item the job runs: who asked for the change. */
  issue?: string;
  createdAt: string;
  expiresAt: string;
}

/**
 * An approval of a plan: a row of its own, so the plan itself never changes. A person's, or the hopper's own (`auto`,
 * `by` the hopper) when auto-approve is on and the plan is one an operator may approve.
 */
export interface PlanApproval { plan: string; by: string; at: string; auto?: true }

/** Who approves a plan, by its risk (issue #870 part 3): an operator (or an admin), an admin only, or nobody. */
export type PlanApprover = 'operator' | 'admin' | 'nobody';

/** The plans' settings, an admin's: whether the hopper approves a plan an operator may approve when the plan is kept. */
export interface InfraPlanSettings { autoApprove: boolean }
export const DEFAULT_INFRA_PLAN_SETTINGS: InfraPlanSettings = { autoApprove: false };

/** Who `auto` approvals name. */
export const AUTO_APPROVER = 'the hopper';

/** A plan as the hopper shows it: the plan, without its text, its approval, and who may approve it and why. */
export interface PlanView extends Omit<InfraPlan, 'text'> {
  approval?: PlanApproval;
  approver: { who: PlanApprover; why: string };
  /** Issue #909: an API token asked to approve it, and a person is to confirm it; only while it waits. */
  asked?: { asker: string; at: string };
}
/** A plan as the repository keeps it: who may approve it is read from its summary each time, never kept. */
export type KeptPlanView = Omit<PlanView, 'approver'>;

/** An apply (issue #896): a credential the vault minted for an approved plan, from its `vault.minted` event, with the granted AWS actions it was narrowed to (issue #2206). Never the credential. */
export interface PlanApply { plan: string; at: string; operation: string; asset: Asset; job: string; expiresAt: string; renewal: boolean; actions?: { action: string; resource: string }[] }

export interface InfraPlanRepository {
  add(plan: InfraPlan, file?: Buffer): void;
  get(id: string): InfraPlan | undefined;
  file(id: string): Buffer | undefined;
  /** The newest first, at most `limit`, without their text. */
  list(limit: number): KeptPlanView[];
  approve(a: PlanApproval): void;
  approval(id: string): PlanApproval | undefined;
}

/** Why a job's plan input is not one the hopper keeps, or undefined. */
export function planInputProblem(p: PlanInput): string | undefined {
  if (!(PLAN_TOOLS as readonly string[]).includes(p.tool)) return `tool must be one of ${PLAN_TOOLS.join(', ')}`;
  const asset = profileProblem({ operation: 'apply', asset: p.asset });
  if (asset) return asset;
  // Argo CD applies what git says (issue #959): the plan of its sync is the GitOps diff.
  if (p.asset.kind === 'argocd-app' && p.tool !== 'gitops') return `a plan for an argocd-app is a gitops plan (argocd app diff), not ${p.tool}`;
  if (!p.target.trim() || p.target.length > 200 || /[\n\r]/.test(p.target)) return 'target must be one line of 1 to 200 characters: the workspace or app the plan changes';
  if (!REPO.test(p.repo)) return 'repo must be owner/name';
  if (!REF.test(p.ref)) return 'ref must be the branch the plan was made from';
  if (!COMMIT.test(p.commit)) return 'commit must be the full commit the plan was made at (40 or 64 hex)';
  if (p.pullRequest !== undefined && (!Number.isInteger(p.pullRequest) || p.pullRequest < 1)) return 'pullRequest must be a pull request number';
  if (p.read !== undefined && !/^read\/[a-z-]+\/\S{1,200}$/.test(p.read)) return 'read must be the read profile the plan was made with: read/<kind>/<asset>';
  if (!p.text.trim()) return 'text must hold the plan: terraform show of the plan file, or the diff';
  if (Buffer.byteLength(p.text) > PLAN_TEXT_MAX) return `text must be at most ${PLAN_TEXT_MAX} bytes`;
  if (p.json !== undefined && Buffer.byteLength(p.json) > PLAN_JSON_MAX) return `json must be at most ${PLAN_JSON_MAX} bytes`;
  return undefined;
}

/** The read profile of a credential the vault minted for `asset`, as a plan names it: `read/<kind>/<asset>`. */
export const readProfileOf = (asset: Asset): string => `read/${asset.kind}/${asset.name}`;

/**
 * Why a plan's `read` is not a read credential the vault minted for its job (`minted`, as `readProfileOf` says each), or
 * undefined (part 5). A plan that names none is kept: the job may have planned with a vault secret.
 */
export function readRefusal(read: string | undefined, minted: readonly string[]): string | undefined {
  if (read === undefined || minted.includes(read)) return undefined;
  return `read names ${read}, but the vault minted this job no such read credential (it minted ${minted.length ? minted.join(', ') : 'none'}): a plan names the read credential it was made with`;
}

const sameAsset = (a: Asset, b: Asset): boolean => a.kind === b.kind && a.name === b.name;

/**
 * Why the vault mints no credential for `profile` on `planId`, before the head is read; or undefined. A read needs no
 * plan, and an observe (issue #2146) changes no asset either. A change needs one: kept, of the same asset, not stale, approved.
 */
export function applyRefusal(profile: OperationProfile, planId: string | undefined, plan: InfraPlan | undefined, approval: PlanApproval | undefined, now: Date): string | undefined {
  if (!changesAsset(profile)) return undefined;
  const plan_again = `Record a plan (POST /job/infra-plans), have a person approve it, then ask with --plan <id>${profile.asset.kind === 'aws-role' ? `. For AWS actions with no terraform, helm or gitops plan, ask for apply/aws-role/<account>/${ACTION_ROLE} with --action <service:Action>=<resource ARN> and no plan: a person's grant of each action approves the change` : ''}`;
  if (planId === undefined) return `no apply without a plan: ${profileInWords(profile)} changes infrastructure, and the ask names no plan. ${plan_again}`;
  if (!plan) return `no plan ${planId}: ${plan_again}`;
  if (!sameAsset(plan.asset, profile.asset)) return `plan ${plan.id} is a plan for ${plan.asset.kind} ${plan.asset.name}, not ${profile.asset.kind} ${profile.asset.name}`;
  if (now.getTime() >= Date.parse(plan.expiresAt)) return `plan ${plan.id} is stale: it was made ${plan.createdAt} and could be applied until ${plan.expiresAt}. Plan again`;
  const failed = failedChecks(plan);
  if (failed) return `plan ${plan.id} failed its checks: ${failed}. Fix the code and plan again`;
  if (!approval) return `plan ${plan.id} is not approved: a person approves it in Needs you, under Infra plans. Wait with on: infra plan ${plan.id}, then ask again`;
  return undefined;
}

/**
 * Why the vault mints nothing for `profile` while **infra applies** are off (issue #1722), or undefined: on, or no change.
 * Off, the hopper is read-only on infrastructure: no write, sync or apply is minted, plan or not, and no step applies.
 */
export function appliesRefusal(profile: OperationProfile, on: boolean): string | undefined {
  if (on || !changesAsset(profile)) return undefined;
  return `infra applies are off on this hopper: it mints no credential for ${profileInWords(profile)}. ${THROUGH_CI}. Ask for read only`;
}
const THROUGH_CI = 'An infrastructure change goes through CI: push it to the infrastructure repository, and its pipeline applies it after its environment approval';
/** Why a need or box step that applies (a plan, or a need but read) does not run while infra applies are off (issue #1722). */
export const APPLY_STEP_OFF = `infra applies are off on this hopper: it runs no step that applies (one with a plan, or with a need of write, sync or apply). ${THROUGH_CI}. Run read steps only`;

/** The words of the checks a plan failed (the MAP tag), or undefined: such a plan is never approved or applied. */
export const failedChecks = (plan: Pick<InfraPlan, 'summary'>): string | undefined =>
  (plan.summary?.failed ? plan.summary.checks.filter((c) => !c.ok).map((c) => c.words).join('; ') : undefined);

/** Why the plan cannot be applied at the branch's head now, or undefined. */
export const headRefusal = (plan: InfraPlan, head: string): string | undefined => (head === plan.commit
  ? undefined
  : `the code moved since plan ${plan.id}: ${plan.repo} ${plan.ref} is at ${head.slice(0, 12)} now, the plan was made at ${plan.commit.slice(0, 12)}. Plan again`);

const RISK_WORDS: Record<PlanRisk, string> = { destroy: 'destroys', iam: 'IAM and identity', prod: 'prod', data: 'data', network: 'network' };

/**
 * Who approves a plan, and why (approval by risk, issue #870 part 3). A low-risk plan whose every environment named is uat:
 * an operator — the person who runs the jobs —, or the hopper when auto-approve is on. Any other: an admin only, as the
 * blast-radius gate's Let through is (prod, IAM and identity, destroys, data, a diff the hopper cannot read, another
 * environment or none named, a plan kept before summaries). A plan that failed a check: nobody.
 */
export function approverOf(plan: Pick<InfraPlan, 'summary'>): { who: PlanApprover; why: string } {
  const s = plan.summary;
  const failed = failedChecks(plan);
  if (failed) return { who: 'nobody', why: `it failed its checks: ${failed}` };
  if (!s) return { who: 'admin', why: 'it was kept before plans had a summary' };
  if (s.level === 'high') {
    const risks = s.risks.filter((r) => r.risk !== 'network').map((r) => RISK_WORDS[r.risk]);
    return { who: 'admin', why: `high risk: ${risks.length > 0 ? risks.join(', ') : 'the hopper found no change it knows in the diff'}` };
  }
  if (s.environments.length > 0 && s.environments.every((e) => e === 'uat')) return { who: 'operator', why: 'low risk, in uat only' };
  return { who: 'admin', why: `low risk, but not in uat only: ${s.environments.length > 0 ? `in ${s.environments.join(', ')}` : 'environment not named'}` };
}

/** Why a person of `role` may not approve the plan, or undefined. */
export function approveRefusal(plan: Pick<InfraPlan, 'id' | 'summary'>, role: UiRole): string | undefined {
  const { who, why } = approverOf(plan);
  if (who === 'nobody') return `plan ${plan.id} failed its checks, so nobody approves it: ${failedChecks(plan)}`;
  if (who === 'admin' && !roleAllows(role, 'admin')) return `plan ${plan.id} is ${why}: only an admin approves it`;
  if (!roleAllows(role, 'operator')) return `plan ${plan.id} is ${why}: an operator or an admin approves it`;
  return undefined;
}
