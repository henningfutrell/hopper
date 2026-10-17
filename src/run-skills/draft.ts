// A file-issue run (issues #472, #475, design.md "Run skills" and "Draft constraints"): the skill checked whole, the
// request checked against the user's draft scope — a repository of theirs, a text and a context within their limits —
// before the CLI runs, the context masked, the prompt to the user's AI CLI on stdin, locked down, and the draft checked:
// in the form asked for (issue #474: an answer that is not is refused in plain words), then masked, then checked
// against the constraints. The draft goes back to the user to read and edit; nothing goes to GitHub
// here. `draftIssue` runs the user's `claude` in print mode (src/plugins/claude-print.ts); on a machine (`wrap` with
// `ON_MACHINE`) in a fresh private dir there, removed after with claude's project dir for it. `draftIssueWith` takes
// any provider's turn: src/drafting/ runs the one the user picked on the machine they picked.
import { z } from 'zod';
import { claudePrint, type ClaudePrintOptions } from '../plugins/claude-print.ts';
import { checkDraft, checkRequest, maskDraft, repoRefusal, maskContext, type DraftFinding, type DraftScope, type DraftMask } from './constraints.ts';
import { FILE_ISSUE_JSON_SCHEMA, fileIssuePrompt, ISSUE_DRAFT, type FileIssueInput, type IssueDraft } from './file-issue.ts';
import { checkRunSkill, loadRunSkill, type RunSkill } from './index.ts';

export interface IssueDraftResult {
  /** The draft as masked: what the user reads and edits. */
  draft: IssueDraft;
  /** What the mask changed in the draft, by constraint, never the value: the user sees it, and the record keeps it. */
  masks: DraftMask[];
  /** What was masked in the context before it was sent, the same way. */
  contextMasks: DraftMask[];
  /** What the draft still breaks: the user sees it, and the text is checked again (`checkDraft` at `file`) before it is filed. */
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

export async function draftIssueWith(
  run: DraftTurn, input: FileIssueInput, scope: DraftScope, signal: AbortSignal, skill: RunSkill = loadRunSkill('file-issue'),
): Promise<IssueDraftResult | { error: string }> {
  const refused = checkRunSkill(skill) ?? repoRefusal(input.repo, scope) ?? checkRequest(input);
  if (refused) return { error: refused };
  const context = input.context ? maskContext(input.context, scope) : undefined;
  const sent = { ...input, ...(context ? { context: context.text } : {}) };
  const r = await run(fileIssuePrompt(skill, sent), FILE_ISSUE_JSON_SCHEMA, signal);
  if ('error' in r) return r;
  const parsed = ISSUE_DRAFT.safeParse(r.answer);
  if (!parsed.success) return { error: NOT_A_DRAFT };
  const { draft, masks } = maskDraft({ ...parsed.data, repo: input.repo }, scope);
  const { repo: _repo, ...shown } = draft;
  return {
    draft: shown, masks, contextMasks: context?.masks ?? [], findings: checkDraft(draft, scope),
    skill: { name: skill.name, id: skill.id }, ...(r.model ? { model: r.model } : {}),
  };
}

export function draftIssue(
  o: Omit<ClaudePrintOptions, 'jsonSchema'>, input: FileIssueInput, scope: DraftScope, signal: AbortSignal,
  skill: RunSkill = loadRunSkill('file-issue'),
): Promise<IssueDraftResult | { error: string }> {
  return draftIssueWith(async (prompt, jsonSchema, s) => {
    // Read as any object: the form is checked once, above, for every provider.
    const r: Record<string, unknown> = await claudePrint({ ...o, jsonSchema }, z.record(z.string(), z.unknown()), prompt, s);
    if (typeof r.error === 'string' && Object.keys(r).length === 1) return { error: r.error };
    const { model, ...answer } = r;
    return { answer, ...(typeof model === 'string' ? { model } : {}) };
  }, input, scope, signal, skill);
}
