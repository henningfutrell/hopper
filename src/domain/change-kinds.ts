// Change kinds (issue #1076, design.md "Change kinds"): what kind of change a pull request is, read from its diff, and so
// which gate its merge takes. Each file it changes is classified by path and content rules, per repository; the most
// severe file is the pull request's kind. A file is, in this order: sensitive by path (auth, secrets, migrations, the
// sandbox, CI, infra, dependencies, agent instructions); docs by path (Markdown, `docs/`); sensitive by content (a
// changed line matches a content rule; docs are not read); tests by path; docs again when every changed line is a
// comment or blank (comment-only); low-risk by path (styles, images); else code. A file whose content is needed and was
// not read is code: never lighter than what was proved. Each kind names a merge gate: `ready`, the hopper merges it once
// it is ready with no person, yolo mode on or off; `yolo`, only with yolo mode on (the gate before kinds); `person`, only
// a person's Merge now. Not classified — no files known, too many to name —, yolo mode decides, as before. Pure.
import { posix } from 'node:path';

export const CHANGE_KINDS = ['docs', 'tests', 'low_risk', 'code', 'sensitive'] as const;
/** From the lightest to the most severe: a pull request is the kind of its most severe file. */
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const MERGE_GATES = ['ready', 'yolo', 'person'] as const;
/** `ready`: merged when ready, no person asked. `yolo`: merged when ready only with yolo mode on. `person`: a person merges. */
export type MergeGate = (typeof MERGE_GATES)[number];

export interface ChangeRule {
  /** Globs of docs files: never read for content. */
  docs: string[];
  /** Globs of test files. */
  tests: string[];
  /** Globs of low-risk code. */
  lowRisk: string[];
  /** Globs of sensitive files: they win over every other rule. */
  sensitive: string[];
  /** Regular expressions (case-insensitive): a changed line of a file that is no docs and matches one is sensitive. */
  sensitiveContent: string[];
  /** The merge gate of each kind. */
  merge: Record<ChangeKind, MergeGate>;
}

/** A rule's change: each list it names replaces the list; each merge gate it names replaces that gate. */
export type ChangeRulePatch = Partial<Omit<ChangeRule, 'merge'>> & { merge?: Partial<Record<ChangeKind, MergeGate>> };

/** The rules an admin set: over the built-in rule for every repository (`default`), then per repository, `owner/repo` lowercased. */
export interface ChangeKindSettings {
  default?: ChangeRulePatch;
  repos?: Record<string, ChangeRulePatch>;
}

/** A pull request's classification: its kind, why (a few files and the rule each matched), and the rule's key. */
export interface ChangeClass {
  kind: ChangeKind;
  why: string[];
  /** `ruleKey` of the rule that classified it: a different rule classifies it again. */
  rule: string;
}

/** Each glob in any directory, and any path inside a directory of that name. */
const anywhere = (...names: string[]): string[] => names.flatMap((n) => [`**/${n}`, `**/${n}/**`]);

export const DEFAULT_CHANGE_RULE: ChangeRule = {
  docs: ['**/*.md', '**/*.mdx', '**/*.rst', '**/*.adoc', '**/*.txt', 'docs/**', '**/LICENSE*'],
  tests: ['**/*.test.*', '**/*.spec.*', 'test/**', 'tests/**', '**/__tests__/**'],
  lowRisk: ['**/*.css', '**/*.scss', '**/*.less', '**/*.svg', '**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.gif', '**/*.webp', '**/*.ico'],
  sensitive: [
    // Agent instructions: they steer every job.
    '**/AGENTS*.md', '**/CLAUDE.md', '**/SKILL.md', ...anywhere('.claude', '.agents'),
    // Sign-in, secrets, access, the sandbox and trust boundaries.
    ...anywhere('*auth*', '*sign-in*', '*secret*', '*vault*', '*crypt*', '*token*', '*access*', '*permission*', '*sandbox*', '*trust*'),
    '**/*.pem', '**/*.key', '**/.env*',
    // Persisted state.
    ...anywhere('*migration*'),
    // CI, infra, deploy, scripts.
    '.github/**', '**/.gitlab-ci.yml', '.circleci/**', '**/CODEOWNERS', '**/Dockerfile*', '**/*.dockerfile', '**/*compose*.yml', '**/*compose*.yaml',
    '**/*.tf', '**/*.tfvars', ...anywhere('infra', 'deploy', 'k8s', 'helm'), '**/*.sh',
    // Dependencies.
    '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/requirements*.txt', '**/go.mod', '**/go.sum', '**/Cargo.toml', '**/Cargo.lock',
  ],
  sensitiveContent: ['\\b(password|passwd|secret|private[_-]?key|api[_-]?key|credential)s?\\b', 'child_process', '\\beval\\s*\\(', '\\bnew Function\\s*\\(', 'process\\.env'],
  merge: { docs: 'ready', tests: 'yolo', low_risk: 'ready', code: 'yolo', sensitive: 'yolo' },
};

const patched = (r: ChangeRule, p: ChangeRulePatch | undefined): ChangeRule =>
  p ? { ...r, ...Object.fromEntries(Object.entries(p).filter(([k, v]) => k !== 'merge' && v !== undefined)), merge: { ...r.merge, ...p.merge } } : r;

/** The rule of `repo`: the built-in rule, then the admin's default, then the repository's own. */
export function changeRuleFor(s: ChangeKindSettings | undefined, repo: string): ChangeRule {
  return patched(patched(DEFAULT_CHANGE_RULE, s?.default), s?.repos?.[repo.toLowerCase()]);
}

/** A short key of a rule (FNV-1a of its JSON): a pull request classified under another key is classified again. */
export function ruleKey(r: ChangeRule): string {
  let h = 0x811c9dc5;
  for (const c of JSON.stringify(r)) h = Math.imul(h ^ c.charCodeAt(0), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/** Whether the hopper merges a ready pull request of this kind: its gate; not classified, yolo mode decides. */
export function mergesOnReady(r: ChangeRule, yolo: boolean, kind: ChangeKind | undefined): boolean {
  const gate = kind ? r.merge[kind] : 'yolo';
  return gate === 'ready' || (gate === 'yolo' && yolo);
}

const firstGlob = (globs: string[], file: string): string | undefined => globs.find((g) => posix.matchesGlob(file, g));

/** The changed files whose content can change the kind: neither docs nor sensitive by path; none when a path is sensitive. */
export function contentNeeded(r: ChangeRule, files: string[]): string[] {
  if (files.some((f) => firstGlob(r.sensitive, f))) return [];
  return files.filter((f) => !firstGlob(r.docs, f));
}

/** The comment markers of a file's language, by its extension; none: comments are not told apart from code. */
const C_LIKE = ['//', '/*', '*/', '*'];
const HASH = ['#'];
const COMMENTS: Record<string, string[]> = Object.fromEntries([
  ...['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'java', 'kt', 'kts', 'scala', 'go', 'rs', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'css', 'scss', 'less', 'php', 'dart'].map((e) => [e, C_LIKE]),
  ...['py', 'rb', 'pl', 'r', 'yml', 'yaml', 'toml'].map((e) => [e, HASH]),
]);

/** Every changed line blank or a comment of the file's language. A `*` line counts only as a block comment's ` * ` line. */
function commentsOnly(file: string, lines: string[]): boolean {
  const markers = COMMENTS[posix.extname(file).slice(1).toLowerCase()];
  if (!markers || lines.length === 0) return false;
  return lines.every((l) => {
    const t = l.trim();
    if (t === '') return true;
    return markers.some((m) => (m === '*' ? t === '*' || t.startsWith('* ') : t.startsWith(m)));
  });
}

const SEVERITY: Record<ChangeKind, number> = { docs: 0, tests: 1, low_risk: 2, code: 3, sensitive: 4 };
/** The most reasons a classification keeps. */
export const MAX_WHY = 5;

/** The changed lines of each file whose content was read (`contentNeeded`), without their `+` or `-`; `binary`: no lines. */
export type ChangedLines = Record<string, string[] | 'binary'>;

function fileKind(r: ChangeRule, file: string, lines: ChangedLines, content: RegExp[]): { kind: ChangeKind; why: string } {
  const at = (kind: ChangeKind, why: string) => ({ kind, why: `${file}: ${why}` });
  const sensitive = firstGlob(r.sensitive, file);
  if (sensitive) return at('sensitive', `sensitive path (${sensitive})`);
  const docs = firstGlob(r.docs, file);
  if (docs) return at('docs', `docs path (${docs})`);
  const read = lines[file];
  if (read === undefined) return at('code', 'content not read');
  const text = read === 'binary' ? [] : read;
  const hit = content.find((re) => text.some((l) => re.test(l)));
  if (hit) return at('sensitive', `sensitive content (${hit.source})`);
  const tests = firstGlob(r.tests, file);
  if (tests) return at('tests', `test path (${tests})`);
  if (read !== 'binary' && commentsOnly(file, read)) return at('docs', 'comments only');
  const low = firstGlob(r.lowRisk, file);
  if (low) return at('low_risk', `low-risk path (${low})`);
  return at('code', 'code');
}

/**
 * The kind of a change to `files`, with `lines` the changed lines of the files `contentNeeded` named; undefined: no
 * files. Why names the files of its kind, at most `MAX_WHY`.
 */
export function classifyChange(r: ChangeRule, files: string[], lines: ChangedLines): ChangeClass | undefined {
  if (files.length === 0) return undefined;
  const content = r.sensitiveContent.map((s) => new RegExp(s, 'i'));
  const each = files.map((f) => fileKind(r, f, lines, content));
  const kind = each.reduce<ChangeKind>((k, f) => (SEVERITY[f.kind] > SEVERITY[k] ? f.kind : k), 'docs');
  const of = each.filter((f) => f.kind === kind).map((f) => f.why);
  const why = of.length > MAX_WHY ? [...of.slice(0, MAX_WHY - 1), `and ${of.length - MAX_WHY + 1} more files`] : of;
  return { kind, why, rule: ruleKey(r) };
}
