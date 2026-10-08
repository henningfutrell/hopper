// The UI session's route groups that register with the operator and admin guards and the request's tenant:
// a job source's intake actions (issue #440), the logins' (issue #476), the failures' (issue #509).
import { registerFailureRoutes } from './failures.ts';
import { registerLoginRoutes } from './logins.ts';
import { registerSourceIntakeRoutes } from './source-intake.ts';

export const ROUTE_GROUPS = [registerSourceIntakeRoutes, registerLoginRoutes, registerFailureRoutes] as const;
