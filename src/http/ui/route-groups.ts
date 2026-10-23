// The UI session's route groups that register with the operator and admin guards and the request's tenant:
// a job's actions (issue #501), a job source's intake actions (issue #440), the logins' (issue #476), the failures' (issue #509),
// the priority lane settings (issue #535), the review sections' — proposals, research (issues #537, #543), the blast
// radius' (issue #542), the decider calls' (issue #550), the phase shifts from a question (issue #548), yolo mode (issue #579), Contribution (issue #429), artifacts (issue #624),
// the TL;DR (issue #569), lane tuning (issue #688), Report a bug (issue #694), Merge now, Close PR and Tend again (issues #677, #1010),
// repositories with no checks (issue #677), where the app is installed (issue #1250), the mint test (issue #781), asking on the issue thread (issue #435), pointed jobs (issue #425), direct jobs (issue #901), promotions to GitHub (issue #946), File an issue (issue #471), GitHub watches (issue #427), the Windows hosts (issue #731), the repository job rules (issue #1472), search's Reindex (issue #945), tool sign-in, the job's terminal and the machine's terminal (issue #1128), the job's transcript (issue #1169).
import { registerArtifactRoutes } from './artifacts.ts';
import { registerTokenBudgetRoutes } from './token-budget.ts';
import { registerPreemptionRoutes } from './preemption.ts';
import { registerBugReportRoutes } from './bug-reports.ts';
import { registerBlastRadiusRoutes } from './blast-radius.ts';
import { registerFailureRoutes } from './failures.ts';
import { registerJobActionRoutes } from './job-actions.ts';
import { registerLaneTuningRoutes } from './lane-tuning.ts';
import { registerLoginRoutes } from './logins.ts';
import { registerToolSignInRoutes } from './tool-sign-in.ts';
import { registerJobTerminalRoutes } from './job-terminal.ts';
import { registerJobTranscriptRoutes } from './job-transcript.ts';
import { registerMachineTerminalRoutes } from './machine-terminal.ts';
import { registerMachineCredentialRoutes } from './machine-credentials.ts';
import { registerMinorDecisionRoutes } from './minor-decisions.ts';
import { registerPriorityLaneRoutes } from './priority-lanes.ts';
import { registerPullRequestActRoutes } from './pull-request-acts.ts';
import { registerRepoChecksRoutes } from './repo-checks.ts';
import { registerInstallationsRoutes } from './installations.ts';
import { registerPhaseShiftRoutes } from './phase-shifts.ts';
import { registerPointedJobRoutes } from './pointed-jobs.ts';
import { registerDirectJobRoutes } from './direct-jobs.ts';
import { registerPromotionRoutes } from './promotions.ts';
import { registerIssueDraftRoutes } from './issue-drafts.ts';
import { registerGitHubWatchRoutes } from './github-watches.ts';
import { registerComponentWatcherRoutes } from './component-watchers.ts';
import { registerReviewRoutes } from './reviews.ts';
import { registerSourceIntakeRoutes } from './source-intake.ts';
import { registerIntakeActorRoutes } from './intake-actors.ts';
import { registerIntakeAutoApprovalRoutes } from './intake-auto-approval.ts';
import { registerIntakeDeclineRoutes } from './intake-decline.ts';
import { registerIntakeStrictnessRoutes } from './intake-strictness.ts';
import { registerSandboxStrictnessRoutes } from './sandbox-strictness.ts';
import { registerThreadAskRoutes } from './thread-ask.ts';
import { registerTldrRoutes } from './tldr.ts';
import { registerVaultRoutes } from './vault.ts';
import { registerVaultGrantRoutes } from './vault-grants.ts';
import { registerMintTestRoutes } from './vault-mint-test.ts';
import { registerInfraPlanRoutes } from './infra-plans.ts';
import { registerSandboxRequestRoutes } from './sandbox-requests.ts';
import { registerBastionRoutes } from './bastions.ts';
import { registerYoloModeRoutes } from './yolo-mode.ts';
import { registerLandingBatchRoutes } from './landing-batches.ts'; import { registerDeliverySettingsRoutes } from './delivery-settings.ts';
import { registerContributionRoutes } from './contribution.ts';
import { registerShrinkGuardRoutes } from './shrink-guard.ts';
import { registerWindowsHostRoutes } from './windows-hosts.ts'; import { registerPodmanHostRoutes } from './podman-hosts.ts'; import { registerClusterRoutes } from './clusters.ts';
import { registerRepoJobRulesRoutes } from './repo-job-rules.ts'; import { registerSkillLibraryRoutes } from './skill-library.ts';
import { registerSearchRoutes } from '../search.ts';
import { registerTaggedStartRoutes } from './tagged-start.ts';

export const ROUTE_GROUPS = [registerJobActionRoutes, registerSourceIntakeRoutes, registerIntakeActorRoutes, registerIntakeAutoApprovalRoutes, registerIntakeDeclineRoutes, registerIntakeStrictnessRoutes, registerLoginRoutes, registerToolSignInRoutes, registerJobTerminalRoutes, registerJobTranscriptRoutes, registerMachineTerminalRoutes, registerMachineCredentialRoutes, registerFailureRoutes, registerPriorityLaneRoutes, registerReviewRoutes, registerBlastRadiusRoutes, registerMinorDecisionRoutes, registerPhaseShiftRoutes, registerVaultRoutes, registerVaultGrantRoutes, registerSandboxRequestRoutes, registerBastionRoutes, registerSandboxStrictnessRoutes, registerMintTestRoutes, registerYoloModeRoutes, registerLandingBatchRoutes, registerDeliverySettingsRoutes, registerContributionRoutes, registerShrinkGuardRoutes, registerArtifactRoutes, registerTokenBudgetRoutes, registerPreemptionRoutes, registerTldrRoutes, registerLaneTuningRoutes, registerBugReportRoutes, registerPullRequestActRoutes, registerRepoChecksRoutes, registerInstallationsRoutes, registerThreadAskRoutes, registerPointedJobRoutes, registerDirectJobRoutes, registerTaggedStartRoutes, registerPromotionRoutes, registerIssueDraftRoutes, registerGitHubWatchRoutes, registerComponentWatcherRoutes, registerInfraPlanRoutes, registerWindowsHostRoutes, registerPodmanHostRoutes, registerClusterRoutes, registerRepoJobRulesRoutes, registerSkillLibraryRoutes, registerSearchRoutes] as const;
