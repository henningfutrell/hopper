// The rules: the owner's standing rules, given to every escalation level — the config document
// `rules.md` (design.md "Config documents"). Read on every ask, so an edit (from the UI or the CLI)
// applies to the next question without a restart. A UI edit replaces it whole against the version it
// was read at (issue #18).
import type { ConfigDocuments } from '../domain/ports.ts';
import type { RulesView } from '../domain/types.ts';

export const RULES = 'rules.md';

export interface Rules {
  text: string;
  /** True when there is no rules document yet; the prompt and the attempt reason say so. */
  missing: boolean;
}

/** The most a UI edit may write: rules go into every escalation level's prompt. */
export const RULES_MAX_BYTES = 64 * 1024;

/** Read on every ask, so edits apply to the next question. None yet → empty, flagged. */
export function readRules(documents: ConfigDocuments): Rules {
  const text = documents.read(RULES);
  return text === undefined ? { text: '', missing: true } : { text, missing: false };
}

/** The rules as the UI reads them; `version` is the document's. */
export function rulesView(documents: ConfigDocuments): RulesView {
  const text = documents.read(RULES);
  return { document: RULES, text: text ?? '', version: documents.version(RULES), missing: text === undefined };
}

export type RulesEdit = { ok: true; view: RulesView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the rules with `text` if they are still at `version`. */
export function writeRules(documents: ConfigDocuments, text: string, version: string): RulesEdit {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > RULES_MAX_BYTES) return { ok: false, code: 'invalid', error: `the rules may hold at most 64 KiB; this is ${bytes} bytes` };
  if (!documents.write(RULES, text, version)) return { ok: false, code: 'conflict', error: `${RULES} changed since it was read; reload and edit again` };
  return { ok: true, view: rulesView(documents) };
}
