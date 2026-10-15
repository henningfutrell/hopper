// A person's act answered before its slow work (issue #1194, design.md "Actions answer at once"): the give-back failed
// after the answer, or Merge now or Close PR did. Part of EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and
// examples (examples.ts).
import { z } from 'zod';
import { GIVE_BACK_ACTS } from '../domain/give-back.ts';
import { ACTION_VIAS, PULL_REQUEST_ACTS } from '../domain/types.ts';

export const GIVE_BACK_EVENT_SCHEMAS = {
  'job.give_back_failed': z.strictObject({ act: z.enum(GIVE_BACK_ACTS), error: z.string(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() }),
  'job.pull_request_act_failed': z.strictObject({ act: z.enum(PULL_REQUEST_ACTS), error: z.string(), person: z.string().optional(), via: z.enum(ACTION_VIAS).optional() }),
} as const;

/** Its part of the event reference (docs.ts). */
export const GIVE_BACK_EVENT_DOCS = {
  'job.give_back_failed': 'A person\'s act on this ended job that gives its item back was answered at once — Run again (`act` `rerun`), Rework (`rework`), Failures\' Retry (`retry`), a hand-off\'s Continue (`continue`) or I fixed it (`fixed`), Push it (`push`), Tend again (`tend`) —, and its source\'s give-back, which runs after the answer (issue #1194) — on GitHub the issue reopened, assigned and its end labels gone, for Rework the pull request made a draft first —, or what follows it, failed: `error` says why (GitHub out of reach or refusing, the issue no longer assigned to the connected account, a newer job of its item made meanwhile, for Retry its work done at its source). No new job was made, and the act is offered again. `person` and `via` say who and the way.',
  'job.pull_request_act_failed': 'A person\'s Merge now (`act` `merge`) or Close PR (`close`) on this finished job\'s open pull request was answered at once (issue #1194), and its source\'s merge or close, which runs after the answer, failed: `error` says why (GitHub refused it — a draft, merge conflicts, a required check — or was out of reach, or the pull request was no longer open). The pull request stays as it was, and the act is offered again. `person` and `via` say who and the way.',
} as const;

/** Its examples (examples.ts). */
export const GIVE_BACK_EVENT_EXAMPLES = {
  'job.give_back_failed': { act: 'rerun', error: 'its source could not give the item back: GitHub answered 502', person: 'Pat', via: 'ui' },
  'job.pull_request_act_failed': { act: 'merge', error: 'merge refused: Pull Request is not mergeable (HTTP 405)', person: 'Pat', via: 'ui' },
} as const;
