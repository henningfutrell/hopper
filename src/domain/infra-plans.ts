// Infra plans (issue #870, design.md "Infra plans: no apply without a plan"): a plan of an infrastructure change — a
// `terraform plan` (its text and its saved plan file), a `helm diff`, a GitOps diff — kept as its own record, apart from
// artifacts, and never changed once kept. The vault mints a credential that can change infrastructure (any operation but
// `read`) only for an apply that names a plan of the same asset, made at the commit its branch is at now, not stale, and
// approved by a person. The types, the limits, the checks and the repository port. Pure.
import { profileProblem, type Asset, type OperationProfile } from './access.ts';
import type { PlanSummary } from './infra-plan-summary.ts';
import { profileInWords } from './minting.ts';

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
  /** The asset the apply mints a credential for: an `aws-role`, a `cluster`, a `namespace`. */
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

/** A person's approval of a plan: a row of its own, so the plan itself never changes. */
export interface PlanApproval { plan: string; by: string; at: string }

/** A plan as the hopper shows it: the plan, without its text, and its approval. */
export interface PlanView extends Omit<InfraPlan, 'text'> { approval?: PlanApproval }

/** An apply (issue #896): a credential the vault minted for an approved plan, from its `vault.minted` event. Never the credential. */
export interface PlanApply { plan: string; at: string; operation: string; asset: Asset; job: string; expiresAt: string; renewal: boolean }

export interface InfraPlanRepository {
  add(plan: InfraPlan, file?: Buffer): void;
  get(id: string): InfraPlan | undefined;
  file(id: string): Buffer | undefined;
  /** The newest first, at most `limit`, without their text. */
  list(limit: number): PlanView[];
  approve(a: PlanApproval): void;
  approval(id: string): PlanApproval | undefined;
}

/** Why a job's plan input is not one the hopper keeps, or undefined. */
export function planInputProblem(p: PlanInput): string | undefined {
  if (!(PLAN_TOOLS as readonly string[]).includes(p.tool)) return `tool must be one of ${PLAN_TOOLS.join(', ')}`;
  const asset = profileProblem({ operation: 'apply', asset: p.asset });
  if (asset) return asset;
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

const sameAsset = (a: Asset, b: Asset): boolean => a.kind === b.kind && a.name === b.name;

/**
 * Why the vault mints no credential for `profile` on `planId`, before the head is read; or undefined. A read needs no
 * plan. Any other operation needs one: kept, of the same asset, not stale, approved.
 */
export function applyRefusal(profile: OperationProfile, planId: string | undefined, plan: InfraPlan | undefined, approval: PlanApproval | undefined, now: Date): string | undefined {
  if (profile.operation === 'read') return undefined;
  const plan_again = 'Record a plan (POST /job/infra-plans), have a person approve it, then ask with --plan <id>';
  if (planId === undefined) return `no apply without a plan: ${profileInWords(profile)} changes infrastructure, and the ask names no plan. ${plan_again}`;
  if (!plan) return `no plan ${planId}: ${plan_again}`;
  if (!sameAsset(plan.asset, profile.asset)) return `plan ${plan.id} is a plan for ${plan.asset.kind} ${plan.asset.name}, not ${profile.asset.kind} ${profile.asset.name}`;
  if (now.getTime() >= Date.parse(plan.expiresAt)) return `plan ${plan.id} is stale: it was made ${plan.createdAt} and could be applied until ${plan.expiresAt}. Plan again`;
  const failed = failedChecks(plan);
  if (failed) return `plan ${plan.id} failed its checks: ${failed}. Fix the code and plan again`;
  if (!approval) return `plan ${plan.id} is not approved: a person approves it on Infra, then the job asks again`;
  return undefined;
}

/** The words of the checks a plan failed (the MAP tag), or undefined: such a plan is never approved or applied. */
export const failedChecks = (plan: Pick<InfraPlan, 'summary'>): string | undefined =>
  (plan.summary?.failed ? plan.summary.checks.filter((c) => !c.ok).map((c) => c.words).join('; ') : undefined);

/** Why the plan cannot be applied at the branch's head now, or undefined. */
export const headRefusal = (plan: InfraPlan, head: string): string | undefined => (head === plan.commit
  ? undefined
  : `the code moved since plan ${plan.id}: ${plan.repo} ${plan.ref} is at ${head.slice(0, 12)} now, the plan was made at ${plan.commit.slice(0, 12)}. Plan again`);
