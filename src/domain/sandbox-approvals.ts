// Sandboxes a job starts (issue #991, design.md "Sandboxes jobs start"): the user's two toggles that skip a person's
// approval, and sandbox YOLO, which is both. **Skip template approval**: a template the hopper makes for a job's
// request is approved at once, its write, sync and apply profiles with it. **Skip sandbox approval**: the box a job asks
// for starts the moment the job asks, a high-blast-radius one too. Both off by default. Each approval a toggle gives is an
// event that names the toggle as its `by`. Pure.

/** A user's sandbox approval toggles, kept in their settings (key `sandboxApprovals`). */
export interface SandboxApprovals { skipTemplateApproval: boolean; skipSandboxApproval: boolean }

/** Never set: both off. A person approves each new template and each sandbox run. */
export const NO_SKIPS: SandboxApprovals = { skipTemplateApproval: false, skipSandboxApproval: false };

/** Who approves when skip template approval is on: what the approval and its events say. */
export const SKIP_TEMPLATE_APPROVER = 'skip template approval';
/** Who approves when skip sandbox approval is on. */
export const SKIP_SANDBOX_APPROVER = 'skip sandbox approval';

/** Sandbox YOLO: both toggles on. Nobody has to do anything. */
export const sandboxYolo = (a: SandboxApprovals): boolean => a.skipTemplateApproval && a.skipSandboxApproval;

/**
 * The toggles after an edit: `yolo` sets both, then each toggle named sets itself. Absent fields keep what was there.
 */
export function editedApprovals(was: SandboxApprovals, e: { yolo?: boolean; skipTemplateApproval?: boolean; skipSandboxApproval?: boolean }): SandboxApprovals {
  const base = e.yolo === undefined ? was : { skipTemplateApproval: e.yolo, skipSandboxApproval: e.yolo };
  return {
    skipTemplateApproval: e.skipTemplateApproval ?? base.skipTemplateApproval,
    skipSandboxApproval: e.skipSandboxApproval ?? base.skipSandboxApproval,
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
  /** Who approved it: a person, or `skip sandbox approval`. */
  approvedBy?: string;
  /** The box's name, once it started. */
  container?: string;
  /** Why it was declined or failed. */
  reason?: string;
}
