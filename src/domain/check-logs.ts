// A failed check's log (issue #993, design.md "Failed checks' logs"): a check that GitHub Actions ran names its job in its
// link, the hopper reads that job's log itself, and the tending job is told a trimmed excerpt of it — the failing tests,
// the error lines and the summary —, so no job asks a person to paste a log. Pure.

/** A GitHub Actions job, as a check's link names it: `<web>/<owner>/<name>/actions/runs/<run>/job/<job>`. */
export interface ActionsJob { repo: string; runId: number; jobId: number }

const JOB_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)\/job\/(\d+)(?:[/?#]|$)/;

/** The Actions job a check's link names; undefined: the check is no GitHub Actions job, or has no link. */
export function actionsJobOf(url: string | undefined): ActionsJob | undefined {
  const m = url ? JOB_URL.exec(url) : null;
  return m ? { repo: m[1]!, runId: Number(m[2]), jobId: Number(m[3]) } : undefined;
}

/** The most lines of a log's excerpt, and the most characters of each. */
export const MAX_EXCERPT_LINES = 40;
export const MAX_EXCERPT_LINE_CHARS = 300;
/** The most lines of a summary an excerpt keeps, and of the lines after an error line (its stack). */
const MAX_SUMMARY_LINES = 6;
const MAX_FOLLOWING = 8;
/** The lines of a log with nothing like an error in it: its end. */
const TAIL_LINES = 20;

/** The most characters of a log a job is answered (`check log`): its end, where the failure is. */
export const MAX_JOB_LOG_CHARS = 1_000_000;

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// eslint-disable-next-line no-control-regex -- terminal colour codes are what it removes
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
/** The runner's own line for a step that exited non-zero: it says nothing a fix can use. */
const EXIT_LINE = /^Process completed with exit code \d+\.?$/;
/** GitHub's group markers: they fold the log in its web view. */
const GROUP = /^##\[(?:end)?group\]/;
const ERROR_MARK = /^##\[error\]/;
/** A line that says something failed: a test, an assertion, an uncaught error, a tool's error. */
const ERROR = /\b(?:errors?|fail|failed|failure|unhandled|uncaught|exception|panic|assertion\w*)\b|ERR!|✗|×|✖|^##\[error\]/i;
/** A passing test's line: its name may say "error". */
const PASSED = /^\s*[✓√]/;
/** A test runner's summary: vitest's and jest's count lines. */
const SUMMARY = /^\s*(?:Test Files|Test Suites|Tests|Errors|Snapshots)\s{1,}\S.*\b(?:passed|failed|errors?|skipped|total)\b/;

const clean = (line: string): string => line.replace(TIMESTAMP, '').replace(ANSI, '').replace(/\r$/, '').trimEnd();
const cut = (line: string): string => (line.length > MAX_EXCERPT_LINE_CHARS ? `${line.slice(0, MAX_EXCERPT_LINE_CHARS - 3)}...` : line);

/**
 * A log's excerpt: each line that says something failed, with the lines after it up to a blank line (its stack), and a test
 * runner's summary lines; in the log's order, `...` where lines were left out. At most `MAX_EXCERPT_LINES`, the summary
 * always kept. Without timestamps, colours, group markers, passing tests or the runner's exit line. A log with nothing like
 * an error: its last lines.
 */
export function logExcerpt(log: string): string[] {
  const raw = log.split('\n').map(clean);
  const lines = raw.map((l) => l.replace(ERROR_MARK, ''));
  const skip = (i: number) => GROUP.test(raw[i]!) || EXIT_LINE.test(lines[i]!.trim()) || PASSED.test(lines[i]!) || lines[i]!.trim() === '';
  const summary: number[] = [];
  const errors: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (skip(i)) continue;
    if (SUMMARY.test(lines[i]!)) { summary.push(i); continue; }
    if (!ERROR.test(raw[i]!)) continue;
    errors.push(i);
    for (let j = i + 1; j < lines.length && j <= i + MAX_FOLLOWING && !skip(j) && !SUMMARY.test(lines[j]!) && !ERROR.test(raw[j]!); j++) errors.push(j);
  }
  const kept = summary.slice(-MAX_SUMMARY_LINES);
  if (errors.length === 0 && kept.length === 0) return render(lines, lines.flatMap((_, i) => (skip(i) ? [] : [i])).slice(-TAIL_LINES));
  // Errors are left out from the last, until the excerpt with its `...` marks fits.
  for (let n = Math.min(errors.length, MAX_EXCERPT_LINES); ; n--) {
    const out = render(lines, [...new Set([...errors.slice(0, n), ...kept])].sort((a, b) => a - b));
    if (out.length <= MAX_EXCERPT_LINES || n === 0) return out.slice(0, MAX_EXCERPT_LINES);
  }
}

/** The lines `picked`, in order, each cut, with `...` where lines were left out between them. */
function render(lines: readonly string[], picked: readonly number[]): string[] {
  return picked.flatMap((i, k) => [...(k > 0 && i !== picked[k - 1]! + 1 ? ['...'] : []), cut(lines[i]!)]);
}

/** Why the hopper could not read a check's log, from GitHub's answer: what the job is told, and a person can act on. */
export function whyNoLog(status: number | undefined, message: string): string {
  if (/rate limit/i.test(message)) return `GitHub's rate limit holds it: ${message}. The hopper reads it again at the next tend.`;
  if (status === undefined) return `GitHub did not answer: ${message}.`;
  if (status === 401 || status === 403) {
    return `GitHub refused it (${status}: ${message}): the hopper's GitHub connection may not read Actions logs. A person gives the hopper's GitHub App the Actions read permission.`;
  }
  if (status === 404 || status === 410) return `GitHub has no log for it (${status}: ${message}): the log expired, or the run was deleted.`;
  return `GitHub answered ${status}: ${message}.`;
}
