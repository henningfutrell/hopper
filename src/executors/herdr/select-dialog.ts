// Claude's select dialogs without numbers (issue #534): its startup dialogs — folder trust, external imports, the
// bypass warning — list their options with the cursor (❯) on one and no digit to type, above the key hints "Enter
// to confirm · Esc to cancel". Read as a question with its options numbered; answered with arrow keys and Enter.

const HINT = /^\s*(Enter to confirm|Esc to cancel)\b/;
const NUMBERED = /^\s*(❯\s*)?\d+\.\s+\S/;
const CURSOR = /^\s*❯\s*\S/;
/** The top of a dialog: its border. */
const TOP = /^\s*(─{3,}|╭)/;
const MAX_LINES = 40;

/** A select on screen: its option lines `from`..`to`, the option the cursor is on, and each option's words. */
export interface Select { from: number; to: number; cursor: number; options: string[] }

const strip = (l: string): string => l.replace(/^[\s●❯│┃]+/, '').replace(/[\s│┃]+$/, '');
const words = (s: string): string => s.replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** The select on screen: the block of lines just above its last key hints, the cursor on one. Undefined when none, or numbered. */
export function selectOf(lines: readonly string[]): Select | undefined {
  let hint = -1;
  for (let i = lines.length - 1; i >= 0 && hint < 0; i--) if (HINT.test(lines[i]!)) hint = i;
  let to = hint - 1;
  while (to >= 0 && lines[to]!.trim() === '') to--;
  if (to < 0) return undefined;
  let from = to;
  while (from > 0 && lines[from - 1]!.trim() !== '') from--;
  const block = lines.slice(from, to + 1);
  const cursor = block.findIndex((l) => CURSOR.test(l));
  if (cursor < 0 || block.some((l) => NUMBERED.test(l))) return undefined;
  return { from, to, cursor, options: block.map(strip) };
}

/** The select as a question: its title and text from its border down, then its options, numbered from 1. */
export function selectText(lines: readonly string[], s: Select): string {
  let from = s.from;
  while (from > 0 && s.from - from < MAX_LINES && !TOP.test(lines[from - 1]!)) from--;
  const head = lines.slice(from, s.from).map(strip).filter((l) => l !== '');
  return [...head, ...s.options.map((o, i) => `${i + 1}. ${o}`)].join('\n');
}

/**
 * The keys that pick the option `answer` names — its number as the question lists it, or its own words, case and
 * spacing aside — from the cursor: arrows, then Enter; with that number. Undefined when no select is on screen or it
 * names none.
 */
export function selectKeys(text: string, answer: string): { keys: string[]; option: number } | undefined {
  const s = selectOf(text.split('\n'));
  if (!s) return undefined;
  const number = /^\s*(\d+)\.?\s*$/.exec(answer)?.[1];
  const at = number !== undefined ? Number(number) - 1 : s.options.findIndex((o) => words(o) === words(answer));
  if (at < 0 || at >= s.options.length) return undefined;
  const moves = at - s.cursor;
  return { keys: [...Array.from({ length: Math.abs(moves) }, () => (moves > 0 ? 'down' : 'up')), 'enter'], option: at + 1 };
}
