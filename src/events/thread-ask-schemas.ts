// Payload schemas of asking on the issue thread (issue #435, design.md "The hopper label means full automation"), split
// from schemas.ts for its line budget: a question held for review before it goes on the thread, a person's approval of
// it, the post, and an admin's change to the policy.
import { z } from 'zod';
import { THREAD_ASK_POLICIES } from '../domain/types.ts';

const strict = z.strictObject;
const policy = z.enum(THREAD_ASK_POLICIES as [string, ...string[]]);
const settings = strict({ ownRepos: policy, otherRepos: policy });

export const THREAD_ASK_EVENT_SCHEMAS = {
  // The policy for the job's repository is `review`: the comment waits on a person's approval.
  'question.thread_held': strict({ questionId: z.string(), repo: z.string(), number: z.number().int() }),
  'question.thread_approved': strict({ questionId: z.string(), by: z.string() }),
  // `approvedBy`: who approved it; absent: the policy posted it with no review.
  'question.thread_posted': strict({ questionId: z.string(), url: z.string(), approvedBy: z.string().optional() }),
  'thread_ask.settings_changed': strict({ from: settings, to: settings, by: z.string() }),
};
