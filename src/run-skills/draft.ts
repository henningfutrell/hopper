// A file-issue run (issue #472, design.md "Run skills"): the skill checked whole, its prompt to the user's `claude` in
// print mode on stdin, locked down (src/plugins/claude-print.ts), and the draft checked against the constraints. The
// draft goes back to the user to read and edit; nothing goes to GitHub here. On a machine (`wrap` with `ON_MACHINE`)
// claude runs in a fresh private dir there, removed after with claude's project dir for it.
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

export async function draftIssue(
  o: Omit<ClaudePrintOptions, 'jsonSchema'>, input: FileIssueInput, signal: AbortSignal, skill: RunSkill = loadRunSkill('file-issue'),
): Promise<IssueDraftResult | { error: string }> {
  const refused = checkRunSkill(skill);
  if (refused) return { error: refused };
  const r = await claudePrint({ ...o, jsonSchema: FILE_ISSUE_JSON_SCHEMA }, ISSUE_DRAFT, fileIssuePrompt(skill, input), signal);
  if ('error' in r) return r;
  const { model, ...draft } = r;
  return { draft, findings: checkDraft(draft), skill: { name: skill.name, id: skill.id }, ...(model ? { model } : {}) };
}
