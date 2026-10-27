// The job egress events (issue #2849, design.md "A job's egress allowlist"): a running job's connection out the hopper
// refused, and an admin's change of the allowlist. Part of EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and
// examples (examples.ts).
import { z } from 'zod';

export const JOB_EGRESS_EVENT_SCHEMAS = {
  'job.egress_denied': z.strictObject({ host: z.string(), port: z.number().int(), repo: z.string().optional(), reason: z.enum(['not_listed', 'local_address']) }),
  'job_egress.ask_answered': z.strictObject({ by: z.string(), host: z.string(), port: z.number().int(), repo: z.string().optional(), answer: z.enum(['approved', 'dismissed']), for: z.enum(['repo', 'all']).optional() }),
  'job_egress.changed': z.strictObject({ by: z.string(), defaults: z.boolean(), route: z.boolean().optional(), confine: z.boolean().optional(), hosts: z.number().int(), repos: z.number().int() }),
} as const;

/** Its part of the event reference (docs.ts). */
export const JOB_EGRESS_EVENT_DOCS = {
  'job.egress_denied': 'The hopper refused a running job\'s connection out (issue #2849, `GET /job/egress`): `host` and `port` as the job named them, `repo` the job\'s repository. `reason`: `not_listed`, the host and port are not on the job\'s egress allowlist (the hopper\'s defaults, the user\'s hosts and the repository\'s); `local_address`, a listed name resolves to a loopback, link-local or unspecified address, which a job never reaches through the hopper. Recorded once per job, host and port while the hopper runs; the job got 403 each time. Shows on the job\'s timeline.',
  'job_egress.ask_answered': 'A person answered a host the user\'s jobs asked for (issue #2849 part 3, `POST /ui/api/job-egress/asks`): a host off the allowlist that `job.egress_denied` refused (`not_listed`), shown in Needs you and in Settings → Job egress. `host` and `port`, `repo` the jobs\' repository. `answer`: `approved`, the host is now on the allowlist — `for` `repo`, for that repository\'s jobs, or `all`, for every job —, so a job\'s next try goes through; `dismissed`, it stays off, and asks again only when a job is refused after this. `by` is who.',
  'job_egress.changed': 'An admin set the user\'s job egress allowlist (issue #2849, `POST /ui/api/job-egress`): `defaults`, whether the hopper\'s default hosts are on it; `route`, whether a job\'s agent runs behind `hopper-egress` from its next start (part 2; absent before it); `confine`, whether a routed job\'s sandbox also gets a network namespace of its own whose one way out is `hopper-egress` (part 4; absent before it); `hosts`, how many hosts every job may reach; `repos`, how many repositories have hosts of their own. `by` is who. Never the hosts themselves: GET /api/job-egress reads them.',
} as const;

/** Its examples (examples.ts). */
export const JOB_EGRESS_EVENT_EXAMPLES = {
  'job.egress_denied': { host: 'paste.example.com', port: 443, repo: 'octo/tools', reason: 'not_listed' },
  'job_egress.ask_answered': { by: 'Pat', host: 'paste.example.com', port: 443, repo: 'octo/tools', answer: 'approved', for: 'repo' },
  'job_egress.changed': { by: 'Pat', defaults: true, route: true, confine: true, hosts: 1, repos: 2 },
} as const;
