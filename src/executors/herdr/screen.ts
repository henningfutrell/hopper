// The hopper screen protocol over a Claude Code pane: pure functions, no I/O.
// docs/design.md "Phase 2" → "Turn anchor (B1)".

import { DEFAULT_JOB_RULES, PROTOCOL_LINES, jobWorktreeRule, workTreeRule } from '../../job-rules/index.ts';

export { SCRATCH_DIR } from '../../job-rules/index.ts';

/**
 * What the hopper types into a job whose turn ended without a marker (issue #163): that turn was a
 * status note, so nothing answers it and no question opens. One line: it is its own turn anchor.
 */
export const STATUS_NOTE_NUDGE = '[hopper] Your message ended without a marker, so the hopper took it as a status note: no question was opened and nobody will answer it. Go on with the job; if you are waiting for background work, keep waiting. If you need an answer from the user, ask exactly one question and end your message with a line containing only HOPPER_QUESTION. When the job is finished, end with a line containing only HOPPER_DONE; if it cannot be done, a line HOPPER_FAILED followed by the reason.';

/**
 * What follows a job's prompt on its first send: the job rules (issue #172; the default unless given),
 * its work tree (then its own git worktree of it, or of `checkout`, its repository's checkout in it, when it
 * has one: issues #379, #361), the protocol. The job rules are editable; the work tree and the protocol are not.
 */
export function protocolFooter(cwd: string, jobRules: string = DEFAULT_JOB_RULES, scratch?: string, jobWorktree?: string, sharedDependencies = false, checkout?: string): string {
  const rules = jobRules.trim();
  return [...(rules ? [rules] : []), workTreeRule(cwd, scratch), ...(jobWorktree !== undefined ? [jobWorktreeRule(jobWorktree, checkout ?? cwd, sharedDependencies)] : []), ...PROTOCOL_LINES].join('\n');
}

/** The last footer line as Claude echoes it: the turn anchor of the first send. */
export const FOOTER_ANCHOR = PROTOCOL_LINES.at(-1)!;

export type Marker = 'done' | 'question' | 'failed' | 'auth';

/** The fields a job reports a login with, after HOPPER_AUTH_PENDING (issue #476): the login's URL and code among them. */
export const AUTH_FIELDS = ['tool', 'kind', 'url', 'code', 'expires_in', 'expires_at', 'interval'] as const;
export type AuthFields = Partial<Record<typeof AUTH_FIELDS[number], string>>;

export interface TurnView {
  /** The last marker after the anchor, or null. */
  lastMarker: Marker | null;
  /** For `failed`: text after the marker on its line, or the next line. */
  failedReason?: string;
  /** For `auth`: the login's fields, as the job wrote them. */
  auth?: AuthFields;
  /** The assistant message holding the last marker (marker removed), else the last message. */
  assistantText: string;
  /** Last non-empty, non-marker output line after the anchor, gutter stripped. Drives progress. */
  lastLine: string;
  /** Output lines after the anchor, chrome left out: more of them is new output (issue #491). */
  outputLines: number;
  anchorFound: boolean;
}

const GUTTER = /^[\s●⎿▎]+/;
const STATUS_LINE = /^\s*[✻✶✳✢✽]\s/; // Claude Code spinner / "Cooked for 5s" line
/** Spinner frames drawn with plain glyphs: "· Symbioting… (20s · ↓ 121 tokens)", "* Crafting… (18m 43s · …)". */
const SPINNER_VARIANT = /^\s*[·*•∗]\s+\S.*…\s*\(\d+[hms]\b/;
/** The hint under a running Bash call. */
const BACKGROUND_HINT = /^\s*\(ctrl\+b to run in background\)\s*$/;
/** The elapsed timer under a running Bash call: "(12s)", "(1m 5s)". */
const ELAPSED_TIMER = /^\s*\((\d+[hms]\s*)+\)\s*$/;
const SEPARATOR = /^\s*─{3,}/;
const USER_ECHO = /^\s*❯/;
const ASSISTANT_START = /^\s*●/;

const compact = (s: string): string => s.replace(/\s+/g, '');
const stripGutter = (line: string): string => line.replace(GUTTER, '').trim();

/** Strip gutter, whitespace and surrounding markdown emphasis. */
export function normaliseMarkerLine(line: string): string {
  let s = stripGutter(line);
  for (;;) {
    const next = s.replace(/^[`*]+/, '').replace(/[`*]+$/, '').trim();
    if (next === s) return s;
    s = next;
  }
}

function markerOf(line: string): Marker | null {
  const s = normaliseMarkerLine(line);
  if (s === 'HOPPER_DONE') return 'done';
  if (s === 'HOPPER_QUESTION') return 'question';
  if (s === 'HOPPER_AUTH_PENDING') return 'auth';
  if (s.startsWith('HOPPER_FAILED')) return 'failed';
  return null;
}

/** One field line of a login: `tool: gh`, `- URL: https://…` (a list mark, emphasis and the name's case aside). */
function authField(line: string): [typeof AUTH_FIELDS[number], string] | undefined {
  const m = /^[-*•\s]*`?([A-Za-z_]+)`?\s*:\s*`?(.*?)`?\s*$/.exec(normaliseMarkerLine(line));
  const key = m?.[1]!.toLowerCase() as typeof AUTH_FIELDS[number] | undefined;
  return key && AUTH_FIELDS.includes(key) && m![2] ? [key, m![2]] : undefined;
}

/**
 * The login after an auth marker at `index` (issue #476): its fields, when nothing but them follows it. A turn
 * that goes on after it — the job went on once the login completed — holds no login any more.
 */
function authAt(lines: string[], index: number): AuthFields | undefined {
  const fields: AuthFields = {};
  for (const l of lines.slice(index + 1)) {
    if (stripGutter(l) === '') continue;
    const f = authField(l);
    if (!f) return undefined;
    fields[f[0]] = f[1];
  }
  return fields;
}

/** True if `line` sits in a user echo block: a ❯ line and its continuation, no assistant line between. */
function inUserEcho(lines: string[], index: number): boolean {
  for (let i = index; i >= 0; i--) {
    const l = lines[i]!;
    if (USER_ECHO.test(l)) return true;
    if (ASSISTANT_START.test(l) || STATUS_LINE.test(l) || SEPARATOR.test(l)) return false;
  }
  return false;
}

/** Index of the line holding the end of the anchor's last echoed occurrence, or -1. */
function anchorLine(lines: string[], anchor: string): number {
  const needle = compact(anchor);
  if (!needle) return -1;
  let text = '';
  const lineAt: number[] = [];
  lines.forEach((l, i) => {
    const c = compact(l);
    text += c;
    for (let k = 0; k < c.length; k++) lineAt.push(i);
  });
  let fallback = -1;
  for (let at = text.lastIndexOf(needle); at >= 0; at = at === 0 ? -1 : text.lastIndexOf(needle, at - 1)) {
    const end = lineAt[at + needle.length - 1]!;
    if (fallback < 0) fallback = end;
    if (inUserEcho(lines, lineAt[at]!)) return end;
  }
  return fallback;
}

/** The right-aligned effort indicator above the input box, e.g. "◐ medium · /effort". */
const EFFORT_LINE = /·\s*\/effort\s*$/;
/** A spinner tip under the status line, e.g. "⎿  Tip: Run /install-github-app …". */
const TIP_LINE = /^\s*(⎿\s*)?Tip:\s/;
/** Claude Code's transcript is scrolled up: "1 new message (ctrl+End) ↓". */
const NEW_MESSAGES_LINE = /\d+ new messages? \(ctrl\+End\)/;

/**
 * The CLI's own update notice, right-aligned above the input box: "✔ Update installed · Restart to update",
 * "✗ Auto-update failed · …". Never the agent's activity and never a blocker (issue #360): a running job
 * keeps its version, and the next job starts on the new one.
 */
const UPDATE_NOTICE = /^\s*[✔✓✗✘⚠]?\s*(Update installed|Update available|Auto-update failed)\b/;

/**
 * A count of background work in the footer, between its "·" separators: "1 shell", "2 background tasks".
 * Captured live: "⏵⏵ bypass permissions on · 1 shell · ← for agents · ↓ to manage".
 */
const BACKGROUND_WORK = /(?:^|·)\s*(\d+ (?:shells?|background tasks?|monitors?|agents?))\s*(?=·|$)/;

/**
 * The background work the footer under the input box names, e.g. "1 shell", or undefined (issue #491).
 * Claude Code wakes the job when it ends, so a job that waits on it needs no nudge.
 */
export function backgroundWork(text: string): string | undefined {
  const lines = text.split('\n');
  const rule = lines.findLastIndex((l) => SEPARATOR.test(l));
  if (rule < 0) return undefined;
  for (const line of lines.slice(rule + 1)) {
    const found = BACKGROUND_WORK.exec(line.trim());
    if (found) return found[1];
  }
  return undefined;
}

/** The xterm sequence for Ctrl+End: scrolls Claude Code's transcript to the end. */
export const CTRL_END = '\x1b[1;5F';

/** True when the screen shows the new-message indicator, i.e. the reply is out of view. */
export function isScrolledUp(text: string): boolean {
  return NEW_MESSAGES_LINE.test(text);
}

function isChrome(line: string): boolean {
  return STATUS_LINE.test(line) || USER_ECHO.test(line) || /^\s*⏵/.test(line) || EFFORT_LINE.test(line) || TIP_LINE.test(line) || NEW_MESSAGES_LINE.test(line)
    || SPINNER_VARIANT.test(line) || BACKGROUND_HINT.test(line) || ELAPSED_TIMER.test(line) || UPDATE_NOTICE.test(line);
}

const isSpinner = (line: string): boolean => STATUS_LINE.test(line) || SPINNER_VARIANT.test(line);

/**
 * Output lines of the turn: after the anchor, up to the input box. What hangs under a spinner — tips and
 * their wrapped lines, notices (issue #360) — is the CLI's chrome, up to the next ● or ❯ line.
 */
function turnLines(lines: string[], from: number): string[] {
  const out: string[] = [];
  let underSpinner = false;
  for (const l of lines.slice(from + 1)) {
    if (SEPARATOR.test(l)) break;
    if (isSpinner(l)) underSpinner = true;
    else if (ASSISTANT_START.test(l) || USER_ECHO.test(l)) underSpinner = false;
    if (!underSpinner && !isChrome(l)) out.push(l);
  }
  return out;
}

/** A ● line that is a tool call, not the agent's words: "● Bash(make)", "● Read 2 files (ctrl+o to expand)". */
const TOOL_CALL = /^\s*●\s*([\w.:-]+\(|.*\(ctrl\+o to expand\)\s*$)/;
/** What a tool call shows under its own line: its output (⎿), wrapped or indented, and blank lines. */
const TOOL_OUTPUT = /^(\s*⎿|\s{4,}\S|\s*$)/;

/**
 * The ● block that contains line `index` (or ends before it), as text without gutter or markers. A block
 * that opens with a tool call is the agent's words after its output (issue #377): never the call.
 */
function blockText(lines: string[], index: number): string {
  let start = index;
  while (start > 0 && !ASSISTANT_START.test(lines[start]!)) start--;
  if (TOOL_CALL.test(lines[start]!)) {
    start++;
    while (start <= index && TOOL_OUTPUT.test(lines[start]!)) start++;
  }
  return lines.slice(start, index + 1)
    .filter((l) => markerOf(l) === null)
    .map(stripGutter)
    .filter((l) => l !== '')
    .join('\n');
}

function failedReason(lines: string[], index: number): string {
  const rest = normaliseMarkerLine(lines[index]!).slice('HOPPER_FAILED'.length).replace(/^[\s:—–-]+/, '').trim();
  if (rest) return rest;
  const next = lines.slice(index + 1).map(stripGutter).find((l) => l !== '');
  return next ?? '';
}

export function readTurn(text: string, anchor: string): TurnView {
  const all = text.split('\n');
  const at = anchorLine(all, anchor);
  const lines = turnLines(all, at);
  let markerIndex = -1;
  lines.forEach((l, i) => { if (markerOf(l)) markerIndex = i; });
  const marker = markerIndex >= 0 ? markerOf(lines[markerIndex]!) : null;
  const auth = marker === 'auth' ? authAt(lines, markerIndex) : undefined;
  // A login's lines carry its code: never activity, never the agent's words (issue #476).
  const authLines = new Set<number>();
  lines.forEach((l, i) => { if (markerOf(l) === 'auth') for (let k = i + 1; k < lines.length && (authField(lines[k]!) || stripGutter(lines[k]!) === ''); k++) authLines.add(k); });
  const shown = lines.filter((_, i) => !authLines.has(i));
  // A bare "…" is where the CLI truncated a long command: not activity.
  const nonEmpty = shown.filter((l) => markerOf(l) === null).map(stripGutter).filter((l) => l !== '' && l !== '…');
  const lastAt = marker === 'auth' && !auth ? -1 : markerIndex;
  const view: TurnView = {
    lastMarker: lastAt >= 0 ? marker : null,
    assistantText: shown.length ? blockText(shown, lastAt >= 0 ? markerIndex - [...authLines].filter((k) => k < markerIndex).length : shown.length - 1) : '',
    lastLine: nonEmpty.at(-1) ?? '',
    outputLines: lines.length,
    anchorFound: at >= 0,
  };
  if (view.lastMarker === 'failed') view.failedReason = failedReason(lines, markerIndex);
  if (view.lastMarker === 'auth') view.auth = auth;
  return view;
}

/** Claude Code's suggestion in an empty input box, e.g. `Try "refactor <filepath>"`: not input. */
const PLACEHOLDER = /^Try "/;

/**
 * What sits unsent in Claude's input box: the ❯ line and its continuation between the last two
 * separators, ❯ removed, lines trimmed. Empty when the box is empty, shows a suggestion, or no box is on
 * screen. Seen live (issue #278): a pasted prompt left as "[Pasted text #1 +29 lines]", never submitted.
 */
export function inputBoxText(text: string): string {
  const lines = text.split('\n');
  let end = -1;
  for (let i = lines.length - 1; i >= 0 && end < 0; i--) if (SEPARATOR.test(lines[i]!)) end = i;
  let start = -1;
  for (let i = end - 1; i >= 0 && start < 0; i--) if (SEPARATOR.test(lines[i]!)) start = i;
  if (start < 0 || !USER_ECHO.test(lines[start + 1] ?? '')) return '';
  const typed = lines.slice(start + 1, end).map((l, i) => (i === 0 ? l.replace(USER_ECHO, '') : l).trim()).filter(Boolean).join('\n');
  return PLACEHOLDER.test(typed) ? '' : typed;
}

/** A PowerShell prompt (`PS C:\\Users\\dev>`), or Windows PowerShell 5.1 refusing `&&`. */
const POWERSHELL = /^PS [A-Za-z]:\\[^>]*>|is not a valid statement separator/;
/** A cmd prompt: `C:\\Users\\dev>`. */
const CMD = /^[A-Za-z]:\\[^>]*>/;

/**
 * The Windows shell a pane's screen shows (issue #367), else undefined. herdr opens a pane in the
 * machine's default shell, PowerShell on Windows; the hopper's pane commands are POSIX shell, which
 * neither PowerShell nor cmd runs. Git Bash and every other POSIX shell name nothing.
 */
export function windowsShellOf(text: string): 'PowerShell' | 'cmd' | undefined {
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.some((l) => POWERSHELL.test(l))) return 'PowerShell';
  if (lines.some((l) => CMD.test(l))) return 'cmd';
  return undefined;
}

/**
 * Claude's folder-trust dialog naming exactly `cwd`: the path printed between
 * "Accessing workspace:" and "Quick safety check", compared with all whitespace removed.
 */
export function isTrustDialog(text: string, cwd: string): boolean {
  if (!text.includes('trust this folder')) return false;
  const head = text.lastIndexOf('Accessing workspace:');
  const tail = text.indexOf('Quick safety check', head);
  if (head < 0 || tail < 0) return false;
  const shown = compact(text.slice(head + 'Accessing workspace:'.length, tail)).replace(/\/+$/, '');
  return shown !== '' && shown === compact(cwd).replace(/\/+$/, '');
}

/**
 * Claude's warning when it starts with every permission granted (yolo, issue #267): its title, and
 * the option that accepts it. The status line under the input box ("bypass permissions on") is not it.
 */
export function isBypassDialog(text: string): boolean {
  return text.includes('running in Bypass Permissions mode') && text.includes('Yes, I accept');
}

/** One option of a select dialog: "❯ 1. Yes", "  2. No, and tell Claude what to do differently (esc)". */
const DIALOG_OPTION = /^\s*(❯\s*)?(\d+)\.\s+(.*\S)\s*$/;

const optionWords = (s: string): string => s.replace(/\(esc\)\s*$/, '').replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The option of the dialog on screen that `answer` names (issue #267), as the digit that picks it:
 * its number, or its own words (case and spacing aside). The dialog is the block of lines, without a
 * blank line, around the last option the cursor (❯) is on; a numbered list in the transcript has no
 * cursor. Undefined when no dialog is on screen or the answer names none of its options.
 */
export function dialogOption(text: string, answer: string): string | undefined {
  const lines = text.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (DIALOG_OPTION.exec(lines[i]!)?.[1]) at = i;
  if (at < 0) return undefined;
  let from = at;
  let to = at;
  while (from > 0 && lines[from - 1]!.trim() !== '') from--;
  while (to < lines.length - 1 && lines[to + 1]!.trim() !== '') to++;
  const options = lines.slice(from, to + 1).map((l) => DIALOG_OPTION.exec(l)).filter((m) => m !== null).map((m) => ({ n: m[2]!, words: optionWords(m[3]!) }));
  const number = /^\s*(\d+)\.?\s*$/.exec(answer)?.[1];
  if (number !== undefined) return options.find((o) => o.n === number)?.n;
  const words = optionWords(answer);
  return options.find((o) => o.words === words)?.n;
}

/** The top of a dialog: its border. */
const DIALOG_TOP = /^\s*(─{3,}|╭)/;
/** Lines that are the dialog's frame or key hints, never its question: "╰───╯", "Esc to cancel · Tab to amend". */
const DIALOG_FRAME = /^([╰╯─\s]+|Esc to \S.*)$/;
const MAX_DIALOG_LINES = 40;

/**
 * The dialog Claude waits at, as its question (issue #377): its title, what it is about, its warnings,
 * any countdown and its options, without the transcript above it. The dialog is the lines up to the
 * last option the cursor (❯) is on, or the last line, and from the border or transcript line above
 * them: a ● line is the agent's own words or the tool call and is kept, a ⎿ line is earlier output
 * and is not. Gutter, box edges and the cursor are removed. Empty when the screen shows nothing.
 */
export function dialogText(text: string): string {
  const lines = text.split('\n');
  const kept = (l: string): boolean => l.trim() !== '' && (DIALOG_OPTION.test(l) || !isChrome(l)) && !DIALOG_FRAME.test(l.trim());
  let at = -1;
  for (let i = lines.length - 1; i >= 0 && at < 0; i--) if (DIALOG_OPTION.exec(lines[i]!)?.[1]) at = i;
  let end = lines.length;
  for (let i = Math.max(at, 0); i < lines.length; i++) if (SEPARATOR.test(lines[i]!) && i > at) { end = i; break; }
  if (at < 0) for (let i = end - 1; i >= 0 && at < 0; i--) if (kept(lines[i]!)) at = i;
  if (at < 0) return '';
  let from = at;
  while (from > 0 && at - from < MAX_DIALOG_LINES) {
    const l = lines[from - 1]!;
    if (DIALOG_TOP.test(l) || /^\s*⎿/.test(l)) break;
    from--;
    if (ASSISTANT_START.test(l)) break;
  }
  return lines.slice(from, end).filter(kept)
    .map((l) => l.replace(/^[\s●❯│┃]+/, '').replace(/[\s│┃]+$/, ''))
    .filter((l) => l !== '')
    .join('\n');
}

/** Claude Code's own countdown on a dialog (issue #376): "… will automatically deny this request in 1:59, …" or "in about 2 minutes". */
const AUTO_DENY = /automatically deny this request in (?:(\d+):(\d{2})|about (\d+) (second|minute)s?)\b/;

/**
 * How long until Claude Code denies the dialog on screen by itself (issue #376), from its countdown; undefined
 * when the dialog has none. Read once, when the question is asked: the countdown is never watched.
 */
export function autoDenyMs(text: string): number | undefined {
  const m = AUTO_DENY.exec(text);
  if (!m) return undefined;
  if (m[1] !== undefined) return (Number(m[1]) * 60 + Number(m[2])) * 1000;
  return Number(m[3]) * (m[4] === 'minute' ? 60_000 : 1000);
}

/**
 * What was typed into the pane after the turn that parked the job: the first user echo (❯ and
 * its continuation lines) after Claude's reply to `anchor`, above the input box. Undefined when
 * nothing was typed (text still in the input box does not count). Lines are trimmed, ❯ removed.
 */
export function typedAfterQuestion(text: string, anchor: string): string | undefined {
  const lines = text.split('\n');
  const at = anchorLine(lines, anchor);
  if (at < 0) return undefined;
  let i = at + 1;
  // Skip the rest of the echo holding the anchor, then Claude's reply, up to the next echo.
  while (i < lines.length && !ASSISTANT_START.test(lines[i]!) && !SEPARATOR.test(lines[i]!)) i++;
  while (i < lines.length && !USER_ECHO.test(lines[i]!) && !SEPARATOR.test(lines[i]!)) i++;
  if (i >= lines.length || SEPARATOR.test(lines[i]!)) return undefined;
  const typed = [lines[i]!.replace(USER_ECHO, '').trim()];
  for (let k = i + 1; k < lines.length; k++) {
    const l = lines[k]!;
    if (l.trim() === '' || ASSISTANT_START.test(l) || STATUS_LINE.test(l) || SEPARATOR.test(l) || USER_ECHO.test(l)) break;
    typed.push(l.trim());
  }
  const out = typed.filter(Boolean).join('\n');
  return out === '' ? undefined : out;
}
