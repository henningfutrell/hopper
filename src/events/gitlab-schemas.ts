// Git through the hopper for GitLab (issue #1448 part 3, design.md "Jobs through GitLab"): a GitLab job's push done, refused,
// or failed at GitLab, with the token of its user's GitLab account (`as`, its username). On the job's timeline. Part of
// EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';

/** A GitLab job's git request: its id, the job's machine, the GitLab username that acted. */
const asked = { requestId: z.string(), machine: z.string().optional(), as: z.string().optional() };
const push = { ...asked, op: z.literal('git.push'), project: z.string() };

export const GITLAB_EVENT_SCHEMAS = {
  'gitlab_proxy.done': z.strictObject({ ...push, refs: z.array(z.string()) }),
  'gitlab_proxy.refused': z.strictObject({ ...push, refs: z.array(z.string()).optional(), reason: z.string() }),
  'gitlab_proxy.failed': z.strictObject({ ...push, refs: z.array(z.string()).optional(), error: z.string() }),
} as const;

/** Its part of the event reference (docs.ts). */
export const GITLAB_EVENT_DOCS = {
  'gitlab_proxy.done': 'A GitLab job\'s git push went through the hopper to GitLab (issue #1448 part 3, design.md "Jobs through GitLab"), with the token of the GitLab account of the job\'s own user: `project`, the job\'s own GitLab project; `refs`, the refs it changed (git\'s push options, such as `merge_request.create`, went with it); `as`, the GitLab username that acted; `requestId` names the request; `machine`, the job\'s machine.',
  'gitlab_proxy.refused': 'The hopper refused a GitLab job\'s git push (issue #1448 part 3) and told the job `reason`: a push to another project than the job\'s own, to its default or a release branch, a tag or a delete, or no GitLab account to push with. Fields as `gitlab_proxy.done`; `refs` when the push was read.',
  'gitlab_proxy.failed': 'GitLab failed or refused a GitLab job\'s git push the hopper made (issue #1448 part 3): `error` is what GitLab answered; a refused token ends the GitLab account. Fields as `gitlab_proxy.done`.',
} as const;

/** Its examples (examples.ts). */
export const GITLAB_EVENT_EXAMPLES = {
  'gitlab_proxy.done': { requestId: 'r4', machine: 'desk', as: 'ada', op: 'git.push', project: 'ada/tools', refs: ['refs/heads/fix-parser'] },
  'gitlab_proxy.refused': { requestId: 'r5', machine: 'desk', as: 'ada', op: 'git.push', project: 'ada/tools', refs: ['refs/heads/main'], reason: 'a job pushes only to a branch of its own work, never to main: push a new branch and open a merge request' },
  'gitlab_proxy.failed': { requestId: 'r6', machine: 'desk', as: 'ada', op: 'git.push', project: 'ada/tools', refs: ['refs/heads/fix-parser'], error: 'GitLab answered 500' },
} as const;
