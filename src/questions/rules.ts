// The rules: the owner's standing rules, given to every escalation level — the config record `rules`,
// a text (design.md "Config in the database"). Read on every ask, so an edit (from the UI or the CLI)
// applies to the next question without a restart. A UI edit replaces it whole against the version it
// was read at (issue #18).
import type { ConfigRecords } from '../domain/ports.ts';
import type { RulesView } from '../domain/types.ts';

/** The config record that holds them. */
export const RULES = 'rules';

export interface Rules {
  text: string;
  /** True when there are no rules yet; the rules view says so. */
  missing: boolean;
}

/** The most a UI edit may write: rules go into every escalation level's prompt. */
export const RULES_MAX_BYTES = 64 * 1024;

/** Why `raw` cannot be the rules, or undefined. */
export function rulesProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return 'the rules are a text';
  const bytes = Buffer.byteLength(raw, 'utf8');
  return bytes > RULES_MAX_BYTES ? `the rules may hold at most 64 KiB; this is ${bytes} bytes` : undefined;
}

const textOf = (raw: unknown): string | undefined => (typeof raw === 'string' ? raw : undefined);

/** Read on every ask, so edits apply to the next question. None yet → empty, flagged. */
export function readRules(config: ConfigRecords): Rules {
  const text = textOf(config.read(RULES));
  return text === undefined ? { text: '', missing: true } : { text, missing: false };
}

/** The rules as the UI reads them; `version` is the record's. */
export function rulesView(config: ConfigRecords): RulesView {
  const text = textOf(config.read(RULES));
  return { text: text ?? '', version: config.version(RULES), missing: text === undefined };
}

export type RulesEdit = { ok: true; view: RulesView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the rules with `text` if they are still at `version`. */
export function writeRules(config: ConfigRecords, text: string, version: string): RulesEdit {
  const problem = rulesProblem(text);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!config.write(RULES, text, version)) return { ok: false, code: 'conflict', error: 'the rules changed since they were read; reload and edit again' };
  return { ok: true, view: rulesView(config) };
}
