// Masking GitHub tokens in text (issue #597): job progress, results, and text the hopper-gh proxy posts to
// GitHub. Patterns: `gh[pousr]_...` (OAuth app, app, user-to-server, server-to-server, refresh) and
// `github_pat_...` (fine-grained personal access token).

/** The GitHub token patterns to mask: OAuth app, app, user-to-server, server-to-server, refresh, and fine-grained PAT. */
const GITHUB_TOKEN_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9_]{20,}/g,      // classic PAT, OAuth, user-to-server, server-to-server, refresh
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,     // fine-grained PAT
];

/** The masked form of a GitHub token: its prefix and length only. */
const masked = (token: string): string => {
  const prefix = token.startsWith('github_pat_') ? 'github_pat_' : token.slice(0, 4);
  return `${prefix}${'*'.repeat(token.length - prefix.length)} (masked)`;
};

/** Mask GitHub tokens in text: each token pattern replaced with its prefix and length. */
export function maskGitHubTokens(text: string): string {
  let result = text;
  for (const pattern of GITHUB_TOKEN_PATTERNS) {
    result = result.replace(pattern, masked);
  }
  return result;
}

/**
 * `text` with every occurrence of `secret` replaced by `[<name>, masked]` (issue #657): a secret the hopper holds, which a
 * service it hands the secret to may repeat in an error. An empty secret masks nothing.
 */
export function maskSecret(text: string, secret: string | undefined, name: string): string {
  if (!secret) return text;
  return text.split(secret).join(`[${name}, masked]`);
}
