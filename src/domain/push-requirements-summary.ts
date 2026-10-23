// The push requirements summary (issue #2555 part 4, design.md "Push requirements"): a job's evaluation of the commit it
// pushed, as a section of its pull request's body — each requirement's status, each check's command, thresholds and
// measured values. Between two hidden lines, so the hopper replaces it after each evaluated push and keeps the rest. Pure.
import type { JudgedRequirement, Threshold } from './push-requirements.ts';

export const SUMMARY_START = '<!-- hopper push requirements -->';
export const SUMMARY_END = '<!-- /hopper push requirements -->';
/** A body holds at most 65536 characters: a long list is cut, and each cell (`cell`). */
const MAX_ROWS = 50;

export interface SummarizedEvaluation { head: string; base: string; passed: boolean; requirements: readonly JudgedRequirement[] }

/** A cell's text on one line, cut at 300 characters, its pipes escaped. */
const cell = (s: string): string => {
  const line = s.replace(/\s*\n\s*/g, ' ');
  return (line.length > 300 ? `${line.slice(0, 299)}…` : line).replace(/\|/g, '\\|');
};
/** A code span that holds any text: a fence longer than its longest run of backticks. */
function code(s: string): string {
  const text = cell(s);
  const fence = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length)) + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}
const bound = (name: string, t: Threshold): string =>
  t.min !== undefined && t.max !== undefined ? `${t.min} ≤ ${name} ≤ ${t.max}` : t.min !== undefined ? `${name} ≥ ${t.min}` : `${name} ≤ ${t.max!}`;
const row = (cells: readonly string[]): string => `|${cells.map((c) => (c ? ` ${c} |` : ' |')).join('')}`;

function rowsOf(q: JudgedRequirement): string[] {
  const head = [code(q.id), q.level];
  if (q.status === 'skipped' || !q.checks?.length) return [row([...head, cell(q.reason ? `${q.status}: ${q.reason}` : q.status), '', '', '', ''])];
  return q.checks.map((c) => row([
    ...head, cell(c.passed ? 'passed' : `failed: ${c.problem ?? 'it did not pass'}`), cell(c.name), code(c.run),
    cell(Object.entries(c.thresholds ?? {}).map(([n, t]) => bound(n, t)).join(', ')),
    cell(Object.entries(c.measured ?? {}).map(([n, v]) => `${n} ${v}`).join(', ')),
  ]));
}

/** The section, its hidden lines included. */
export function pushRequirementsSummary(e: SummarizedEvaluation): string {
  const said = `${e.passed ? 'Passed' : 'Failed'} for \`${e.head.slice(0, 12)}\` against \`${cell(e.base)}\`: the job's evaluation of its pushed commit, in its work tree (\`sh "$HOPPER_REQUIREMENTS" check\`). The hopper replaces this section after each evaluated push.`;
  const rows = e.requirements.flatMap(rowsOf);
  const table = rows.length === 0 ? ['No push requirement applied.'] : [
    '| Requirement | Level | Status | Check | Command | Thresholds | Measured |', '|---|---|---|---|---|---|---|',
    ...rows.slice(0, MAX_ROWS), ...(rows.length > MAX_ROWS ? ['', `And ${rows.length - MAX_ROWS} more rows, on the job's timeline.`] : []),
  ];
  return [SUMMARY_START, '### Push requirements', '', said, '', ...table, '', SUMMARY_END].join('\n');
}

/** `body` with `summary` in place of the one it holds; else before its post key line (post-key.ts, which stays last); else at its end. */
export function withPushRequirementsSummary(body: string, summary: string): string {
  const at = body.indexOf(SUMMARY_START);
  const end = at < 0 ? -1 : body.indexOf(SUMMARY_END, at);
  if (end >= 0) return `${body.slice(0, at)}${summary}${body.slice(end + SUMMARY_END.length)}`;
  const key = /\n*(<!-- hopper post [^\n]* -->)\s*$/.exec(body);
  const text = key ? body.slice(0, key.index) : body;
  const joined = text.trim() === '' ? summary : `${text.trimEnd()}\n\n${summary}`;
  return key ? `${joined}\n\n${key[1]!}` : joined;
}
