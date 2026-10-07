// The hopper screen protocol over a Claude Code pane: pure functions, no I/O.
// docs/design.md "Phase 2" → "Turn anchor (B1)".

import { DEFAULT_JOB_RULES, PROTOCOL_LINES, workTreeRule } from '../../job-rules/index.ts';

export { SCRATCH_DIR } from '../../job-rules/index.ts';

/**
 * What the hopper types into a job whose turn ended without a marker (issue #163): that turn was a
 * status note, so nothing answers it and no question opens. One line: it is its own turn anchor.
 */
export const STATUS_NOTE_NUDGE = '[hopper] Your message ended without a marker, so the hopper took it as a status note: no question was opened and nobody will answer it. Go on with the job; if you are waiting for background work, keep waiting. If you need an answer from the user, ask exactly one question and end your message with a line containing only HOPPER_QUESTION. When the job is finished, end with a line containing only HOPPER_DONE; if it cannot be done, a line HOPPER_FAILED followed by the reason.';

/**
 * What follows a job's prompt on its first send: the job rules (issue #172; the default unless given),
 * its work tree, the protocol. The job rules are editable; the work tree and the protocol are not.
 */
export function protocolFooter(cwd: string, jobRules: string = DEFAULT_JOB_RULES): string {
  const rules = jobRules.trim();
  return [...(rules ? [rules] : []), workTreeRule(cwd), ...PROTOCOL_LINES].join('\n');
}

/** The last footer line as Claude echoes it: the turn anchor of the first send. */
export const FOOTER_ANCHOR = PROTOCOL_LINES.at(-1)!;

export type Marker = 'done' | 'question' | 'failed';

export interface TurnView {
  /** The last marker after the anchor, or null. */
  lastMarker: Marker | null;
  /** For `failed`: text after the marker on its line, or the next line. */
  failedReason?: string;
  /** The assistant message holding the last marker (marker removed), else the last message. */
  assistantText: string;
  /** Last non-empty, non-marker output line after the anchor, gutter stripped. Drives progress. */
  lastLine: string;
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
  if (s.startsWith('HOPPER_FAILED')) return 'failed';
  return null;
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

/** The ● block that contains line `index` (or ends before it), as text without gutter or markers. */
function blockText(lines: string[], index: number): string {
  let start = index;
  while (start > 0 && !ASSISTANT_START.test(lines[start]!)) start--;
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
  // A bare "…" is where the CLI truncated a long command: not activity.
  const nonEmpty = lines.filter((l) => markerOf(l) === null).map(stripGutter).filter((l) => l !== '' && l !== '…');
  const view: TurnView = {
    lastMarker: markerIndex >= 0 ? markerOf(lines[markerIndex]!) : null,
    assistantText: lines.length ? blockText(lines, markerIndex >= 0 ? markerIndex : lines.length - 1) : '',
    lastLine: nonEmpty.at(-1) ?? '',
    anchorFound: at >= 0,
  };
  if (view.lastMarker === 'failed') view.failedReason = failedReason(lines, markerIndex);
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
