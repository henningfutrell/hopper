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

/**
 * The key patterns to mask in a log line (issue #685). A 32-byte key as 64 hex digits: the master key's form, and that
 * of every hex key the hopper makes (webhook signing secrets, sign-in secrets, join codes). A 32-byte key as base64 or
 * base64url, 43 characters and an optional `=`, with upper case, lower case and a digit, as random bytes nearly always
 * have: the master key's other form, and the hopper's client and artifact tokens. A digest after `sha256:` is no key.
 */
const KEY_PATTERNS = [
  /(?<![0-9A-Fa-f]|sha256:)[0-9A-Fa-f]{64}(?![0-9A-Fa-f])/g,
  /(?<![A-Za-z0-9+/_=-])(?=[A-Za-z0-9+/_-]{0,42}[A-Z])(?=[A-Za-z0-9+/_-]{0,42}[a-z])(?=[A-Za-z0-9+/_-]{0,42}[0-9])[A-Za-z0-9+/_-]{43}=?(?![A-Za-z0-9+/_=-])/g,
];

/** `text` with each 32-byte key, as hex, base64 or base64url, replaced by `[key, masked]`. */
export function maskKeys(text: string): string {
  let result = text;
  for (const pattern of KEY_PATTERNS) result = result.replace(pattern, '[key, masked]');
  return result;
}

/**
 * A log line as it may be written (issue #685): each secret in `held` (the master key and its previous keys, in the form
 * they were given) masked by value, then GitHub tokens and the key patterns.
 */
export function maskLogLine(text: string, held: Iterable<string>): string {
  let result = text;
  for (const secret of held) result = maskSecret(result, secret, 'secret');
  return maskKeys(maskGitHubTokens(result));
}
