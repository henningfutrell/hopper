// Masking GitHub tokens in text (issue #597): job progress, results, and text the hopper-gh proxy posts to
// GitHub. Patterns: `gh[pousr]_...` (OAuth app, app, user-to-server, server-to-server, refresh) and
// `github_pat_...` (fine-grained personal access token).

/** The GitHub token patterns to mask: OAuth app, app, user-to-server, server-to-server, refresh, and fine-grained PAT. */
const GITHUB_TOKEN_PATTERNS = [
  /\bghp_[A-Za-z0-9]{36}\b/g,          // OAuth app token
  /\bgho_[A-Za-z0-9]{36}\b/g,          // OAuth app token (old format)
  /\bghu_[A-Za-z0-9]{36}\b/g,          // GitHub App user token
  /\bghs_[A-Za-z0-9]{36}\b/g,          // GitHub App server token
  /\bghr_[A-Za-z0-9]{76}\b/g,          // GitHub App refresh token
  /\bgithub_pat_[A-Za-z0-9_]{82}\b/g,  // Fine-grained PAT
];

/** The masked form of a GitHub token: its prefix and length only. */
const masked = (token: string): string => {
  const prefix = token.substring(0, token.indexOf('_') + 1);
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
