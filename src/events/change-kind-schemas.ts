// Payload schemas of change kinds (issue #1076, design.md "Change kinds"), split from schemas.ts for its line budget: the
// change-kind rules saved with yolo mode, each part optional, and a followed pull request's kind, new or changed, and why.
import { z } from 'zod';
import { CHANGE_KINDS, MERGE_GATES } from '../domain/types.ts';

const strict = z.strictObject;
const globs = z.array(z.string()).optional();
const changeRulePatch = strict({
  docs: globs, tests: globs, lowRisk: globs, sensitive: globs, sensitiveContent: globs,
  merge: z.partialRecord(z.enum(CHANGE_KINDS), z.enum(MERGE_GATES)).optional(),
});
export const changeKinds = strict({ default: changeRulePatch.optional(), repos: z.record(z.string(), changeRulePatch).optional() });

export const CHANGE_KIND_EVENT_SCHEMAS = {
  'job.pull_request_classified': strict({ pullRequest: z.string(), kind: z.enum(CHANGE_KINDS), why: z.array(z.string()) }),
};
