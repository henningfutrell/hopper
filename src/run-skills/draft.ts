// A file-issue run (issue #472, design.md "Run skills"): the skill checked whole, its prompt to the user's AI CLI on
// stdin, locked down, and the draft checked: in the form asked for (issue #474: an answer that is not is refused in
// plain words), then against the constraints. The draft goes back to the user to read and edit; nothing goes to GitHub
// here. `draftIssue` runs the user's `claude` in print mode (src/plugins/claude-print.ts); on a machine (`wrap` with
// `ON_MACHINE`) in a fresh private dir there, removed after with claude's project dir for it. `draftIssueWith` takes
// any provider's turn: src/drafting/ runs the one the user picked on the machine they picked.
import { z } from 'zod';
import { claudePrint, type ClaudePrintOptions } from '../plugins/claude-print.ts';
import { checkDraft, type DraftFinding } from './constraints.ts';
import { FILE_ISSUE_JSON_SCHEMA, fileIssuePrompt, ISSUE_DRAFT, type FileIssueInput, type IssueDraft } from './file-issue.ts';
import { checkRunSkill, loadRunSkill, type RunSkill } from './index.ts';

export interface IssueDraftResult {
  draft: IssueDraft;
  /** What the draft breaks: the user sees it, and the text is checked again before it is filed. */
  findings: DraftFinding[];
  /** The run skill the run used, to record with the draft. */
  skill: { name: string; id: string };
  model?: string;
}

/** What one provider's turn answered: its JSON, with the model that ran when it says; or why there is none. */
export type DraftAnswer = { answer: unknown; model?: string } | { error: string };

/** One provider's turn: the prompt, and the JSON Schema of the answer (a CLI that takes none is told the form in the prompt). */
export type DraftTurn = (prompt: string, jsonSchema: Record<string, unknown>, signal: AbortSignal) => Promise<DraftAnswer>;

export const NOT_A_DRAFT = 'the answer is not a draft in the form asked for (a title, a body and notes, as text)';

export async function draftIssueWith(run: DraftTurn, input: FileIssueInput, signal: AbortSignal, skill: RunSkill = loadRunSkill('file-issue')): Promise<IssueDraftResult | { error: string }> {
  const refused = checkRunSkill(skill);
  if (refused) return { error: refused };
  const r = await run(fileIssuePrompt(skill, input), FILE_ISSUE_JSON_SCHEMA, signal);
  if ('error' in r) return r;
  const parsed = ISSUE_DRAFT.safeParse(r.answer);
  if (!parsed.success) return { error: NOT_A_DRAFT };
  const draft = parsed.data;
  return { draft, findings: checkDraft(draft), skill: { name: skill.name, id: skill.id }, ...(r.model ? { model: r.model } : {}) };
}

export function draftIssue(
  o: Omit<ClaudePrintOptions, 'jsonSchema'>, input: FileIssueInput, signal: AbortSignal, skill: RunSkill = loadRunSkill('file-issue'),
): Promise<IssueDraftResult | { error: string }> {
  return draftIssueWith(async (prompt, jsonSchema, s) => {
    // Read as any object: the form is checked once, above, for every provider.
    const r: Record<string, unknown> = await claudePrint({ ...o, jsonSchema }, z.record(z.string(), z.unknown()), prompt, s);
    if (typeof r.error === 'string' && Object.keys(r).length === 1) return { error: r.error };
    const { model, ...answer } = r;
    return { answer, ...(typeof model === 'string' ? { model } : {}) };
  }, input, signal, skill);
}
