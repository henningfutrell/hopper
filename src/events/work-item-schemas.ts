// The work-item ledger's input from GitHub (issue #1067, part 3): what a followed pull request waits on, as the follow saw
// it change; an issue closed or reopened, as a GitHub delivery or the ledger's fallback read said. Part of EVENT_SCHEMAS
// (schemas.ts).
import { z } from 'zod';
import { PULL_REQUEST_WAITS } from '../domain/work-items.ts';

const strict = z.strictObject;
const via = z.enum(['delivery', 'read']);

export const WORK_ITEM_EVENT_SCHEMAS = {
  'job.pull_request_seen': strict({ pullRequest: z.string(), wait: z.enum(PULL_REQUEST_WAITS) }),
  'work_item.issue_closed': strict({ key: z.string(), reason: z.string().optional(), via }),
  'work_item.issue_reopened': strict({ key: z.string(), via }),
};
