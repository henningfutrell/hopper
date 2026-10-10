// A question's listed options (issue #550, design.md "Decider calls"): the numbered lines a job's question lists —
// "1. …", "2) …", a dialog's cursor and border aside — are the options of the decision, each by its number. The last
// run of them counts, numbered from 1 in order, at least two; anything else is no pick. Pure.
import type { MinorDecisionOption } from '../domain/types.ts';

const NUMBERED = /^[\s│┃|]*(?:❯\s*)?(\d{1,2})[.)]\s+(.+?)[\s│┃|]*$/;
const words = (s: string): string => s.replace(/[\s.]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();

export function questionOptions(text: string): MinorDecisionOption[] {
  let run: MinorDecisionOption[] = [];
  let last: MinorDecisionOption[] = [];
  for (const line of text.split('\n')) {
    const m = NUMBERED.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n === 1) run = [];
    if (n !== run.length + 1) { run = []; continue; }
    run.push({ id: String(n), label: m[2]!.trim() });
    if (run.length >= 2) last = run;
  }
  return last.length >= 2 ? [...last] : [];
}

/** The option an answer names: its number ("2", "2."), or its words, case and spacing aside. */
export function optionNamed(options: readonly MinorDecisionOption[], answer: string): string | undefined {
  const number = /^\s*(\d{1,2})\.?\s*$/.exec(answer)?.[1];
  if (number !== undefined) return options.find((o) => o.id === number)?.id;
  return options.find((o) => words(o.label) === words(answer))?.id;
}
