// The work-item ledger's input from GitHub (issue #1067, part 3): what a followed pull request waits on, as the follow saw
// it change; an issue closed or reopened, as a GitHub delivery or the ledger's fallback read said; a request card withdrawn
// from Intake (part 4). Part of EVENT_SCHEMAS
// (schemas.ts).
import { z } from 'zod';
import { PULL_REQUEST_WAITS, WORK_ITEM_STATES } from '../domain/work-items.ts';
import { BLOCKED_CAUSES } from '../domain/item-lifecycle.ts';
import { ACTION_VIAS } from '../domain/failures.ts';

const strict = z.strictObject;
const via = z.enum(['delivery', 'read']);

export const WORK_ITEM_EVENT_SCHEMAS = {
  'job.pull_request_seen': strict({ pullRequest: z.string(), wait: z.enum(PULL_REQUEST_WAITS) }),
  'source.request_withdrawn': strict({ source: z.string(), key: z.string(), label: z.string().optional() }),
  // `landing` (issue #1232): the hopper closed it itself, done by a pull request its batch run promoted.
  'work_item.issue_closed': strict({ key: z.string(), reason: z.string().optional(), via: z.enum([...via.options, 'landing']) }),
  'work_item.issue_reopened': strict({ key: z.string(), via }),
  // The item reconciler's correction (issue #1891): `replay` folds the item again from its job's end event; else `cause` blocks it.
  'work_item.reconciled': strict({
    key: z.string(), from: z.enum(WORK_ITEM_STATES), jobId: z.string().optional(), cause: z.enum(BLOCKED_CAUSES).optional(),
    replay: strict({ type: z.enum(['job.finished', 'job.failed', 'job.cancelled', 'job.rejected']), data: z.record(z.string(), z.unknown()) }).optional(),
  }),
  // A person's Won't do on a blocked item (issue #1891): the item is dropped.
  'work_item.dropped': strict({
    source: z.string(), key: z.string(), jobId: z.string().optional(), cause: z.enum(BLOCKED_CAUSES).optional(),
    by: strict({ person: z.string(), via: z.enum(ACTION_VIAS) }).optional(),
  }),
  // The one notice of a blocked item (issue #1891): a person is asked.
  'work_item.person_asked': strict({ key: z.string(), cause: z.enum(BLOCKED_CAUSES), jobId: z.string().optional(), pullRequest: z.string().optional() }),
  // An end label a person took off by hand on GitHub (issue #1892): a person's Run again; or put on a dropped item (part 19): it keeps it out.
  'work_item.label_edited': strict({
    source: z.string(), key: z.string(), jobId: z.string().optional(), from: z.enum(WORK_ITEM_STATES), label: z.string(), means: z.enum(['run_again', 'keep_out']),
  }),
};
