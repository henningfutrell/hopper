// The job-hopper screen protocol over a Claude Code pane: pure functions, no I/O.
// docs/design.md "Phase 2" → "Turn anchor (B1)".

export const PROTOCOL_FOOTER = [
  '[job-hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only: JOB_HOPPER_QUESTION',
  'When the job is completely finished, end your final message with a line containing only: JOB_HOPPER_DONE',
  'If the job cannot be done, end with a line containing only: JOB_HOPPER_FAILED followed by the reason.',
].join('\n');

/** The last footer line as Claude echoes it: the turn anchor of the first send. */
export const FOOTER_ANCHOR = PROTOCOL_FOOTER.split('\n').at(-1)!;

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
  if (s === 'JOB_HOPPER_DONE') return 'done';
  if (s === 'JOB_HOPPER_QUESTION') return 'question';
  if (s.startsWith('JOB_HOPPER_FAILED')) return 'failed';
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

function isChrome(line: string): boolean {
  return STATUS_LINE.test(line) || USER_ECHO.test(line) || /^\s*⏵/.test(line) || EFFORT_LINE.test(line);
}

/** Output lines of the turn: after the anchor, up to the input box. */
function turnLines(lines: string[], from: number): string[] {
  const out: string[] = [];
  for (const l of lines.slice(from + 1)) {
    if (SEPARATOR.test(l)) break;
    if (!isChrome(l)) out.push(l);
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
  const rest = normaliseMarkerLine(lines[index]!).slice('JOB_HOPPER_FAILED'.length).replace(/^[\s:—–-]+/, '').trim();
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
  const nonEmpty = lines.filter((l) => markerOf(l) === null).map(stripGutter).filter((l) => l !== '');
  const view: TurnView = {
    lastMarker: markerIndex >= 0 ? markerOf(lines[markerIndex]!) : null,
    assistantText: lines.length ? blockText(lines, markerIndex >= 0 ? markerIndex : lines.length - 1) : '',
    lastLine: nonEmpty.at(-1) ?? '',
    anchorFound: at >= 0,
  };
  if (view.lastMarker === 'failed') view.failedReason = failedReason(lines, markerIndex);
  return view;
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
