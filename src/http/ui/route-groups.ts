// The UI session's route groups that register with the operator and admin guards and the request's tenant:
// a job's actions (issue #501), a job source's intake actions (issue #440), the logins' (issue #476), the failures' (issue #509),
// the priority lane settings (issue #535), the review sections' — proposals, research (issues #537, #543), the blast
// radius' (issue #542), the minor decisions' (issue #550).
import { registerBlastRadiusRoutes } from './blast-radius.ts';
import { registerFailureRoutes } from './failures.ts';
import { registerJobActionRoutes } from './job-actions.ts';
import { registerLoginRoutes } from './logins.ts';
import { registerMinorDecisionRoutes } from './minor-decisions.ts';
import { registerPriorityLaneRoutes } from './priority-lanes.ts';
import { registerReviewRoutes } from './reviews.ts';
import { registerSourceIntakeRoutes } from './source-intake.ts';

export const ROUTE_GROUPS = [registerJobActionRoutes, registerSourceIntakeRoutes, registerLoginRoutes, registerFailureRoutes, registerPriorityLaneRoutes, registerReviewRoutes, registerBlastRadiusRoutes, registerMinorDecisionRoutes] as const;
