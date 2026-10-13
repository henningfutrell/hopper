// Sandboxes a job starts (issue #991, design.md "Sandboxes jobs start"): the user's two toggles that skip a person's
// approval, and sandbox YOLO, which is both. **Skip template approval**: a template the hopper makes for a job's
// request is approved at once, its write, sync and apply profiles with it. **Skip sandbox approval**: the box a job asks
// for starts the moment the job asks, a high-blast-radius one too. Both off by default. Each approval a toggle gives is an
// event that names the toggle as its `by`. Issue #1001: the **auto-approve policy**, per blast radius level — a template
// the hopper makes for a job, and a run of a template, of a level it holds is approved with no person, by the policy.
// Default: low (read only, no vault secret) is approved; medium and high ask a person. Pure.
import { RADIUS_LEVELS, type RadiusLevel } from './blast-radius.ts';

/** The auto-approve policy (issue #1001): for each blast radius level, whether its templates and runs need no person. */
export type AutoApprove = Record<RadiusLevel, boolean>;

/** Never set: low is approved with no person; medium and high ask. */
export const DEFAULT_AUTO_APPROVE: AutoApprove = { low: true, medium: false, high: false };

/** A user's sandbox approval toggles, kept in their settings (key `sandboxApprovals`). */
export interface SandboxApprovals {
  skipTemplateApproval: boolean;
  skipSandboxApproval: boolean;
  /** The auto-approve policy (issue #1001). Absent: saved before it, or never set; the default holds. */
  autoApprove?: AutoApprove;
}

/** The auto-approve policy in force. */
export const autoApproveOf = (a: SandboxApprovals | undefined): AutoApprove => ({ ...DEFAULT_AUTO_APPROVE, ...a?.autoApprove });

/** Whether the policy approves a template or a run of that level with no person. */
export const autoApproves = (a: SandboxApprovals | undefined, level: RadiusLevel | undefined): boolean => level !== undefined && autoApproveOf(a)[level];

/** The levels the policy approves, lowest first. */
export const autoApprovedLevels = (a: SandboxApprovals | undefined): RadiusLevel[] => RADIUS_LEVELS.filter((l) => autoApproveOf(a)[l]);

/** Never set: both off. A person approves each new template and each sandbox run. */
export const NO_SKIPS: SandboxApprovals = { skipTemplateApproval: false, skipSandboxApproval: false };

/** Who approves when skip template approval is on: what the approval and its events say. */
export const SKIP_TEMPLATE_APPROVER = 'skip template approval';
/** Who approves when skip sandbox approval is on. */
export const SKIP_SANDBOX_APPROVER = 'skip sandbox approval';
/** Who approves a template or a run the auto-approve policy holds (issue #1001). */
export const AUTO_APPROVER = 'the auto-approve policy';
/** The approvers that are no person: a template one of them approved does not approve a run for its job. */
export const NO_PERSON: readonly string[] = ['the read policy', SKIP_TEMPLATE_APPROVER, SKIP_SANDBOX_APPROVER, AUTO_APPROVER];

/**
 * Who approves a run that a person's approval of its template covers (issue #1001): the job asked for that template, and
 * the person approved it, so the run needs no second approval.
 */
export const templateApprovalBy = (person: string): string => `the template's approval by ${person}`;

/** Sandbox YOLO: both toggles on. Nobody has to do anything. */
export const sandboxYolo = (a: SandboxApprovals): boolean => a.skipTemplateApproval && a.skipSandboxApproval;

/**
 * The toggles after an edit: `yolo` sets both, then each toggle named sets itself. Absent fields keep what was there.
 */
export function editedApprovals(was: SandboxApprovals, e: { yolo?: boolean; skipTemplateApproval?: boolean; skipSandboxApproval?: boolean; autoApprove?: Partial<AutoApprove> }): SandboxApprovals {
  const base = e.yolo === undefined ? was : { skipTemplateApproval: e.yolo, skipSandboxApproval: e.yolo };
  const auto = e.autoApprove ? { autoApprove: { ...autoApproveOf(was), ...e.autoApprove } } : was.autoApprove ? { autoApprove: { ...was.autoApprove } } : {};
  return {
    skipTemplateApproval: e.skipTemplateApproval ?? base.skipTemplateApproval,
    skipSandboxApproval: e.skipSandboxApproval ?? base.skipSandboxApproval,
    ...auto,
  };
}

/** Where a sandbox request is (issue #991): waits for a person, starts, runs, or ended without a box. */
export type SandboxRequestState = 'waiting' | 'starting' | 'running' | 'declined' | 'failed';

/** One sandbox request as the vault's view shows it: a job's ask for a box of a template. Kept in memory. */
export interface SandboxRequestView {
  id: string;
  jobId: string;
  /** The job's title when it has one, for the person who decides. */
  jobTitle?: string;
  template: string;
  state: SandboxRequestState;
  askedAt: string;
  /** Who approved it: a person, `skip sandbox approval`, the auto-approve policy, or the template's approval by a person. */
  approvedBy?: string;
  /** The box's name, once it started. */
  container?: string;
  /** Why it was declined or failed. */
  reason?: string;
}
