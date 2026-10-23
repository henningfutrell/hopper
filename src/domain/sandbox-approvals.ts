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
  /**
   * How long a person's write, sync or apply approval is remembered, in hours (issue #1001, src/domain/remembered-writes.ts);
   * 0: until an admin forgets it. Absent: the default, a week.
   */
  rememberWritesHours?: number;
  /**
   * The standing read grant (issue #1472, design.md "Vault grants"): on, a job on a box of a template whose needs the read
   * policy holds entirely as reads gets the vault grant with no person (`by` STANDING_READ_GRANTER). Absent: off.
   */
  standingReadGrant?: boolean;
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
/** Who approves a template or a run that a person's remembered write approvals cover (issue #1001). */
export const REMEMBERED_APPROVER = 'a remembered write approval';
/** How long a request waits for a person before the hopper declines it (issue #655 part 9: a held request that times out). */
export const SANDBOX_HOLD_MS = 24 * 60 * 60 * 1000;
/** Who declined a request no person answered in time: not a person, so it lowers no trust (issue #655 part 9). */
export const HOLD_TIMEOUT = 'the hold timeout';
/** Who approves or declines a run Jev's `sandbox-request` check decided (issue #655 part 13): no person. */
export const JEV_APPROVER = 'Jev';
/**
 * The approvers that are no person: a template one of them approved does not approve a run for its job, and a profile one
 * of them approved is not remembered.
 */
export const NO_PERSON: readonly string[] = ['the read policy', SKIP_TEMPLATE_APPROVER, SKIP_SANDBOX_APPROVER, AUTO_APPROVER, REMEMBERED_APPROVER, JEV_APPROVER];

/**
 * Who approves a run that a person's approval of its template covers (issue #1001): the job asked for that template, and
 * the person approved it, so the run needs no second approval.
 */
export const templateApprovalBy = (person: string): string => `the template's approval by ${person}`;

/**
 * Who approves a rerun's run of a template that a person approved for the job it runs again (issue #2639 part 2): that
 * approval, which names the person on that job's timeline.
 */
export const carriedApprovalBy = (jobId: string): string => `the approval of job ${jobId}, which it runs again`;

/** Sandbox YOLO: both toggles on. Nobody has to do anything. */
export const sandboxYolo = (a: SandboxApprovals): boolean => a.skipTemplateApproval && a.skipSandboxApproval;

/**
 * The toggles after an edit: `yolo` sets both, then each toggle named sets itself. Absent fields keep what was there.
 */
export function editedApprovals(was: SandboxApprovals, e: { yolo?: boolean; skipTemplateApproval?: boolean; skipSandboxApproval?: boolean; autoApprove?: Partial<AutoApprove>; rememberWritesHours?: number; standingReadGrant?: boolean }): SandboxApprovals {
  const base = e.yolo === undefined ? was : { skipTemplateApproval: e.yolo, skipSandboxApproval: e.yolo };
  const auto = e.autoApprove ? { autoApprove: { ...autoApproveOf(was), ...e.autoApprove } } : was.autoApprove ? { autoApprove: { ...was.autoApprove } } : {};
  const hours = e.rememberWritesHours ?? was.rememberWritesHours;
  const standing = e.standingReadGrant ?? was.standingReadGrant;
  return {
    skipTemplateApproval: e.skipTemplateApproval ?? base.skipTemplateApproval,
    skipSandboxApproval: e.skipSandboxApproval ?? base.skipSandboxApproval,
    ...auto,
    ...(hours !== undefined ? { rememberWritesHours: hours } : {}),
    ...(standing !== undefined ? { standingReadGrant: standing } : {}),
  };
}

/**
 * Where a sandbox request is (issue #991): waits for a person, approved, or declined. Approved, the job's box steps run,
 * each in a sandbox of its own that the hopper burns after the step (issue #1349); no box waits between them.
 */
export type SandboxRequestState = 'waiting' | 'approved' | 'declined';

/** One sandbox request as the vault's view shows it: a job's ask for a box of a template. Kept in memory. */
export interface SandboxRequestView {
  id: string;
  jobId: string;
  /** The job's title when it has one, for the person who decides. */
  jobTitle?: string;
  /** The job's issue or pull request (issue #1001). */
  jobUrl?: string;
  /** Why the job asks, in its own words (issue #1001: required in its ask). */
  purpose?: string;
  /** What the box will do, in the job's words: the commands or the plan, and for each change what it changes and whether it can be undone. */
  plan?: string;
  template: string;
  state: SandboxRequestState;
  askedAt: string;
  /** Who approved it: a person, `skip sandbox approval`, the auto-approve policy, or the template's approval by a person. */
  approvedBy?: string;
  /** Why it was declined. */
  reason?: string;
  /** Who declined it: a person, the hold timeout when no person answered in time (issue #655 part 9), or Jev (part 13). */
  declinedBy?: string;
  /**
   * Jev's `sandbox-request` check while the request waits (issue #655 part 13): `checking`, Jev reads it now; `held`, Jev
   * held it for a person, with why. Absent: Jev did not check it, or it no longer waits.
   */
  jev?: { state: 'checking' | 'held'; reason?: string };
}
