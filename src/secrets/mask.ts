// GitHub tokens masked in text a job gives (issue #597): its progress, its result, and what it asks the
// GitHub proxy to post. A token printed by a job must not reach the database, an event, the UI or GitHub.
// The shapes are GitHub's token prefixes: `gh` and one letter (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`), and
// `github_pat_` for a fine-grained personal access token.

const GITHUB_TOKEN = /\b(?:gh[a-z]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

/** What a masked token reads as. */
export const MASKED_TOKEN = '[masked GitHub token]';

/** The text with every GitHub token in it masked. */
export const maskTokens = (text: string): string => text.replace(GITHUB_TOKEN, MASKED_TOKEN);

/** A value (a job's result: text, or JSON) with every GitHub token in its text masked. The mask holds no quote or backslash, so the JSON stays valid. */
export const maskTokensIn = (value: unknown): unknown => {
  if (typeof value === 'string') return maskTokens(value);
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(maskTokens(JSON.stringify(value))) as unknown;
};
