// The job rules (issue #172): what every job is told before its work tree and the protocol — the config
// record `job-rules`, a text, edited from the UI (POST /ui/api/job-rules) or with `hopper config set`.
// Read when each job starts, so an edit reaches the next job without a restart. While none is saved, a
// job gets the default: the publishing rule and the parallel-work rule. The work tree line and the
// protocol lines are fixed: the executors set the work tree up, and the hopper reads the markers back
// (src/executors/herdr/screen.ts). design.md "Job rules".
import type { ConfigRecords } from '../domain/ports.ts';
import type { JobRulesView } from '../domain/types.ts';

/** The config record that holds them. */
export const JOB_RULES = 'job-rules';

const PUBLISHING_RULE = "[hopper publishing rule] Any text you send to GitHub (commit messages, branch names, pull request titles and bodies, issue text) describes the change and how it was verified, in neutral terms. Never quote or name the repository owner or any other person. Never include personal or machine details: email addresses, people's names, IP addresses, hostnames, tailnet names, home directory paths, usernames, machine or pane ids, port numbers of local machines, codes, tokens or secrets.";

const PARALLEL_WORK = [
  '[hopper parallel work] Other jobs run at the same time as this one, possibly in the same repos. Nothing orders or holds jobs for each other: no job waits for another.',
  'If your work overlaps another job\'s, sort it out yourself. Either state the assumptions you made about the other work, or make the needed fix in the other project and annotate it with which way the dependency runs (which work depends on which).',
];

/** What a job is told while no job rules are saved. */
export const DEFAULT_JOB_RULES = [PUBLISHING_RULE, ...PARALLEL_WORK].join('\n');

/** Where a job's temporary files go, inside its work tree (design.md "Work tree"). */
export const SCRATCH_DIR = '.hopper-scratch';

/**
 * The fixed line naming the job's work tree. With `scratch`, the job's own scratch dir, which the reap
 * removes when the job ends (issue #401); without, the work tree's shared one.
 */
export const workTreeRule = (cwd: string, scratch?: string): string => `[hopper work tree] This job's work tree is ${cwd}. Do all of the job's work inside it: clones, git worktrees, edits, builds, test runs, scratch and temporary files go under it. Never make or work in a copy of the code outside it, under /tmp or anywhere else. ${scratch
  ? `Temporary files, and clones or git worktrees made only for this job, go in ${scratch}: git ignores it, and TMPDIR and your scratchpad point there. When the job ends, the hopper stops every process the job started and removes that directory, unless a repository in it holds uncommitted or unpushed work.`
  : `Temporary files go in ${cwd}/${SCRATCH_DIR}: git ignores it, and TMPDIR and your scratchpad point there.`} Running or installing what you built, and reading files elsewhere, is fine. If the job seems to need a work tree outside this one, ask instead.`;

/**
 * The fixed line of a job that runs in its own git worktree of its work tree (issue #379): the worktree is
 * the job's alone, in its scratch dir; the work tree is shared with the other jobs there. With
 * `sharedDependencies`, its node_modules is a link to dependencies shared with the repository's other jobs
 * (issue #410).
 */
export const jobWorktreeRule = (path: string, cwd: string, sharedDependencies = false): string => `[hopper job worktree] Work in ${path}: a git worktree of ${cwd} made for this job alone, detached at its remote's default branch as just fetched (at its HEAD when it has no remote), and where you start. Make your branch in it. ${cwd} itself is shared with other jobs: never edit files, switch branches or build in it, and make no other clone or worktree of it for this job. ${sharedDependencies
  ? 'Its node_modules is a link to dependencies shared with the other jobs of this repository: read-only. Before you add, remove or upgrade a dependency, replace the link with an install of your own (rm node_modules && npm ci). '
  : ''}The worktree is in this job's scratch dir, so the reap removes it when the job ends, unless it holds uncommitted or unpushed work.`;

/** The fixed protocol lines: the markers the hopper reads back. The last one is the turn anchor. */
export const PROTOCOL_LINES: readonly string[] = [
  '[hopper protocol] When you need an answer from the user, ask exactly one question and end your message with a line containing only: HOPPER_QUESTION',
  'When the job is completely finished, end your final message with a line containing only: HOPPER_DONE',
  'If the job cannot be done, end with a line containing only: HOPPER_FAILED followed by the reason.',
];

/** The lines after the job rules, as the UI shows them: the work tree (named `<work tree>`), then the protocol. */
export const FIXED_JOB_LINES: readonly string[] = [workTreeRule('<work tree>', `<work tree>/${SCRATCH_DIR}/<job id>`), ...PROTOCOL_LINES];

/** The most an edit may write: the job rules go into every job's prompt. */
export const JOB_RULES_MAX_BYTES = 16 * 1024;

/** Why `raw` cannot be the job rules, or undefined. */
export function jobRulesProblem(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return 'the job rules are a text';
  const bytes = Buffer.byteLength(raw, 'utf8');
  return bytes > JOB_RULES_MAX_BYTES ? `the job rules may hold at most 16 KiB; this is ${bytes} bytes` : undefined;
}

const saved = (config: ConfigRecords): string | undefined => {
  const raw = config.read(JOB_RULES);
  return typeof raw === 'string' ? raw : undefined;
};

/** What a job starting now is told: the saved text (even empty), else the default. */
export function readJobRules(config: ConfigRecords): string {
  return saved(config) ?? DEFAULT_JOB_RULES;
}

/** The job rules as the UI reads them; `version` is the record's. */
export function jobRulesView(config: ConfigRecords): JobRulesView {
  const text = saved(config);
  return { text: text ?? DEFAULT_JOB_RULES, version: config.version(JOB_RULES), missing: text === undefined, default: DEFAULT_JOB_RULES, fixed: [...FIXED_JOB_LINES] };
}

export type JobRulesEdit = { ok: true; view: JobRulesView } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the job rules with `text` if they are still at `version`. */
export function writeJobRules(config: ConfigRecords, text: string, version: string): JobRulesEdit {
  const problem = jobRulesProblem(text);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!config.write(JOB_RULES, text, version)) return { ok: false, code: 'conflict', error: 'the job rules changed since they were read; reload and edit again' };
  return { ok: true, view: jobRulesView(config) };
}
