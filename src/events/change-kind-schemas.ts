// Payload schemas of change kinds (issue #1076, design.md "Change kinds"), split from schemas.ts for its line budget: the
// change-kind rules saved with yolo mode, each part optional, and a followed pull request's kind, new or changed, and why,
// with its docs and examples.
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

export const CHANGE_KIND_EVENT_DOCS = {
  'job.pull_request_classified': 'A followed pull request\'s change kind (issue #1076), new or changed: `kind` — `docs` (docs or comments only), `tests`, `low_risk`, `code` or `sensitive` (auth, secrets, migrations, the sandbox, CI, infra, dependencies, agent instructions, or a line a content rule matches) —, read from the files and lines it changes by the repository\'s change rule, and `why`: a few files and the rule each matched. The kind names its merge gate: merged when ready with no person, merged when ready only with yolo mode on, or merged only by a person. The work-item ledger keeps it on the item.',
};

export const CHANGE_KIND_EVENT_EXAMPLES = {
  'job.pull_request_classified': { pullRequest: 'https://github.com/owner/repo/pull/14', kind: 'docs', why: ['README.md: docs path (**/*.md)'] },
};
