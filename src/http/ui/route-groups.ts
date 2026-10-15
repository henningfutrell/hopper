// The UI session's route groups that register with the operator and admin guards and the request's tenant:
// a job's actions (issue #501), a job source's intake actions (issue #440), the logins' (issue #476), the failures' (issue #509),
// the priority lane settings (issue #535), the review sections' — proposals, research (issues #537, #543), the blast
// radius' (issue #542), the decider calls' (issue #550), the phase shifts from a question (issue #548), yolo mode (issue #579), Contribution (issue #429), artifacts (issue #624),
// auto-park (issue #650), the TL;DR (issue #569), lane tuning (issue #688), Report a bug (issue #694), Merge now, Close PR and Tend again (issues #677, #1010),
// repositories with no checks (issue #677), the mint test (issue #781), asking on the issue thread (issue #435), pointed jobs (issue #425), direct jobs (issue #901), promotions to GitHub (issue #946), GitHub watches (issue #427), the Windows hosts (issue #731), search's Reindex (issue #945), tool sign-in, the job's terminal and the machine's terminal (issue #1128), the job's transcript (issue #1169).
import { registerArtifactRoutes } from './artifacts.ts';
import { registerAutoParkRoutes } from './auto-park.ts';
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
import { registerMinorDecisionRoutes } from './minor-decisions.ts';
import { registerPriorityLaneRoutes } from './priority-lanes.ts';
import { registerPullRequestActRoutes } from './pull-request-acts.ts';
import { registerRepoChecksRoutes } from './repo-checks.ts';
import { registerPhaseShiftRoutes } from './phase-shifts.ts';
import { registerPointedJobRoutes } from './pointed-jobs.ts';
import { registerDirectJobRoutes } from './direct-jobs.ts';
import { registerPromotionRoutes } from './promotions.ts';
import { registerGitHubWatchRoutes } from './github-watches.ts';
import { registerComponentWatcherRoutes } from './component-watchers.ts';
import { registerReviewRoutes } from './reviews.ts';
import { registerSourceIntakeRoutes } from './source-intake.ts';
import { registerIntakeActorRoutes } from './intake-actors.ts';
import { registerThreadAskRoutes } from './thread-ask.ts';
import { registerTldrRoutes } from './tldr.ts';
import { registerVaultRoutes } from './vault.ts';
import { registerVaultGrantRoutes } from './vault-grants.ts';
import { registerMintTestRoutes } from './vault-mint-test.ts';
import { registerInfraPlanRoutes } from './infra-plans.ts';
import { registerSandboxRequestRoutes } from './sandbox-requests.ts';
import { registerYoloModeRoutes } from './yolo-mode.ts';
import { registerLandingBatchRoutes } from './landing-batches.ts';
import { registerContributionRoutes } from './contribution.ts';
import { registerShrinkGuardRoutes } from './shrink-guard.ts';
import { registerWindowsHostRoutes } from './windows-hosts.ts';
import { registerSearchRoutes } from '../search.ts';

export const ROUTE_GROUPS = [registerJobActionRoutes, registerSourceIntakeRoutes, registerIntakeActorRoutes, registerLoginRoutes, registerToolSignInRoutes, registerJobTerminalRoutes, registerJobTranscriptRoutes, registerMachineTerminalRoutes, registerFailureRoutes, registerPriorityLaneRoutes, registerReviewRoutes, registerBlastRadiusRoutes, registerMinorDecisionRoutes, registerPhaseShiftRoutes, registerVaultRoutes, registerVaultGrantRoutes, registerSandboxRequestRoutes, registerMintTestRoutes, registerYoloModeRoutes, registerLandingBatchRoutes, registerContributionRoutes, registerShrinkGuardRoutes, registerArtifactRoutes, registerAutoParkRoutes, registerTldrRoutes, registerLaneTuningRoutes, registerBugReportRoutes, registerPullRequestActRoutes, registerRepoChecksRoutes, registerThreadAskRoutes, registerPointedJobRoutes, registerDirectJobRoutes, registerPromotionRoutes, registerGitHubWatchRoutes, registerComponentWatcherRoutes, registerInfraPlanRoutes, registerWindowsHostRoutes, registerSearchRoutes] as const;
