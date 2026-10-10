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

/**
 * The address patterns Report a bug masks (issue #694): an IPv4 address; an IPv6 address, full or with `::` (so a time
 * such as 12:30:45 is none); a host name under a private suffix (`.local`, `.lan`, `.home`, `.internal`, `.corp`, a
 * tailnet's `.ts.net`); and the user's name in a home directory (`/home/<name>`, `/Users/<name>`).
 */
const H = '[0-9A-Fa-f]{1,4}';
const ADDRESS_PATTERNS: [RegExp, string][] = [
  [/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?![\w.])/g, '[IP address, masked]'],
  [new RegExp(`(?<![\\w:])(?:(?:${H}:){7}${H}|(?:${H}:){1,6}:(?:${H}(?::${H}){0,5})?|::${H}(?::${H}){0,6})(?![\\w:])`, 'g'), '[IP address, masked]'],
  [/(?<![\w.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.(?:local|lan|home|internal|corp|ts\.net)\b/g, '[host, masked]'],
  [/(?<=\/(?:home|Users)\/)[^/\s'"]+/g, '[user, masked]'],
];

/** `text` with each IP address, private host name and home directory's user name masked (issue #694). */
export function maskAddresses(text: string): string {
  let result = text;
  for (const [pattern, mask] of ADDRESS_PATTERNS) result = result.replace(pattern, mask);
  return result;
}
