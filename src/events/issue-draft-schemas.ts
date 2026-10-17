// Payload schemas of File an issue (issue #471, design.md "File an issue"), split from schemas.ts for its line budget: a
// draft written with the person's own signed-in AI connection, and an issue filed on their confirmation; never the text.
import { z } from 'zod';

const strict = z.strictObject;

export const ISSUE_DRAFT_EVENT_SCHEMAS = {
  'issue_draft.drafted': strict({ repo: z.string(), provider: z.string(), model: z.string().optional(), skill: z.string(), findings: z.array(z.string()) }),
  'issue_draft.filed': strict({ repo: z.string(), number: z.number().int(), url: z.string(), by: z.string(), provider: z.string(), skill: z.string() }),
};

export const ISSUE_DRAFT_EVENT_DOCS = {
  'issue_draft.drafted': 'File an issue drafted an issue with the person\'s own signed-in AI connection (issue #471): `repo` it is for, the `provider` and the `model` that ran, the run `skill` and its id (`file-issue@<id>`, issue #472), and `findings`: the ids of the draft constraints the draft as written broke (a secret or personal data is masked before the person sees it). Nothing is filed. Never the text.',
  'issue_draft.filed': 'A person confirmed and filed an issue that File an issue drafted (issue #471), with their own GitHub connection, with no label and no assignee: `repo`, `number`, `url`, `by` who confirmed it, the `provider` and the run `skill` with its id that drafted it. Never the text.',
};

export const ISSUE_DRAFT_EVENT_EXAMPLES = {
  'issue_draft.drafted': { repo: 'octo-org/ops', provider: 'claude', model: 'claude-sonnet-5-5', skill: 'file-issue@3f2a9c1e7b4d5a60', findings: [] },
  'issue_draft.filed': { repo: 'octo-org/ops', number: 13, url: 'https://github.com/octo-org/ops/issues/13', by: 'octocat', provider: 'claude', skill: 'file-issue@3f2a9c1e7b4d5a60' },
};
