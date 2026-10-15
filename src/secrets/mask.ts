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

/**
 * A Claude token (issue #1287): a setup token or a sign-in's access token (`sk-ant-oat01-…`), its refresh token
 * (`sk-ant-ort01-…`). The hopper gives a job pod's pane its user's setup token; a tool's error may repeat its argv.
 */
const CLAUDE_TOKEN_PATTERN = /\bsk-ant-o[ar]t\d\d-[A-Za-z0-9_-]{8,}/g;

/** `text` with each Claude token masked. */
export const maskClaudeTokens = (text: string): string => text.replace(CLAUDE_TOKEN_PATTERN, '[Claude token, masked]');

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
  return maskClaudeTokens(maskKeys(maskGitHubTokens(result)));
}

/**
 * The address patterns Report a bug masks (issue #694): an IPv4 address; an IPv6 address, full or with `::` (so a time
 * such as 12:30:45 is none); a host name under a private suffix (`.local`, `.lan`, `.home`, `.internal`, `.corp`, a
 * tailnet's `.ts.net`); and the user's name in a home directory (`/home/<name>`, `/Users/<name>`).
 */
const H = '[0-9A-Fa-f]{1,4}';
const ADDRESS_PATTERNS: [RegExp, string][] = [
  [/(?<![\w.])(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?!\w|\.\d)/g, '[IP address, masked]'],
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

/**
 * The secret patterns a checkpoint is scrubbed of besides GitHub tokens and 32-byte keys (issue #921): a private key
 * block (PEM or OpenSSH, its lines as text or as `\n` in JSON), an AWS access key id, an Anthropic or OpenAI API key,
 * and a Slack token.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[private key, masked]'],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[AWS access key, masked]'],
  [/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/g, '[API key, masked]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[Slack token, masked]'],
];

/** `text` with GitHub tokens, 32-byte keys, private keys, cloud and API keys masked (issue #921). */
export function maskSecrets(text: string): string {
  let result = text;
  for (const [pattern, mask] of SECRET_PATTERNS) result = result.replace(pattern, mask);
  return maskClaudeTokens(maskKeys(maskGitHubTokens(result)));
}

/** Every string inside a JSON value masked. */
const maskJson = (v: unknown): unknown => {
  if (typeof v === 'string') return maskSecrets(v);
  if (Array.isArray(v)) return v.map(maskJson);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskJson(x)]));
  return v;
};

/**
 * An agent session's log (JSON lines), scrubbed for a checkpoint (issue #921): the strings in each line masked, so
 * every line stays JSON its agent reads; a line that is not JSON masked as text.
 */
export function scrubSessionLog(text: string): string {
  return text.split('\n').map((line) => {
    if (!line.trim()) return line;
    try { return JSON.stringify(maskJson(JSON.parse(line))); } catch { return maskSecrets(line); }
  }).join('\n');
}

/**
 * A patch scrubbed for a checkpoint (issue #921): only the lines it adds are masked. A context or removed line is the
 * base's, as it is on the remote; masking it would keep the patch from applying there.
 */
export function scrubPatch(text: string): string {
  return text.split('\n').map((line) => (line.startsWith('+') && !line.startsWith('+++ ') ? maskSecrets(line) : line)).join('\n');
}
