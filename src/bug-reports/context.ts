// Report a bug (issue #694, design.md "Report a bug"), pure: the context a report carries — the hopper's version and
// revision, the install type, the system, the related job, its failure and plain-language state, its last log lines —
// masked before the person sees it; the report's body; and the terms of the duplicate search.
import type { InstallInfo, Job, JobStatus } from '../domain/types.ts';
import { maskAddresses, maskGitHubTokens, maskKeys, maskSecret } from '../secrets/mask.ts';

/** Where every report goes: the hopper's own repository. */
export const REPORT_REPO = 'henningfutrell/hopper';
/** The one label a report gets: never `hopper`, so a report never starts a job (issue #655 is the gate for the rest). */
export const REPORT_LABEL = 'user-report';
/** How the context names a failure's signature, before its 12 hex digits. */
export const SIGNATURE_LINE = 'Signature: ';
/** The log lines of the job a report carries, the last ones. */
export const TAIL_LINES = 20;

/** A job's state, as a person reads it. */
const STATE_WORDS: Record<JobStatus, string> = {
  queued: 'queued: it waits for a lane', held: 'held: it waits for a person or a rule', claimed: 'starting',
  running: 'running', waiting_answer: 'waiting for an answer to its question', operator_led: 'a person works on it',
  parked: 'parked', waiting_on: 'waiting on something outside the hopper', finished: 'finished',
  failed: 'failed: it stopped with an error', cancelled: 'cancelled', rejected: 'rejected',
};

/** The machine the hopper runs on, as the context names it. */
export interface ReportSystem { platform: string; release: string; arch: string; node: string; hostname: string }

export interface ReportContextInput {
  /** What install.json says of the running build: whatever fields it has. */
  install: Partial<InstallInfo>;
  system: ReportSystem;
  job?: Job;
  /** The failure record of the job, if it has one. */
  failureId?: string;
  /** Its signature (the failure assessor's): the duplicate search looks for it in the open reports' text. */
  signature?: string;
}

/** Text as a report may carry it: tokens, keys, the host name, IP addresses, private host names and home directories masked. */
export function maskReportText(text: string, hostname?: string): string {
  return maskAddresses(maskKeys(maskGitHubTokens(maskSecret(text, hostname, 'host'))));
}

const versionOf = (i: Partial<InstallInfo>): string =>
  (i.commit ? `${i.branch ?? 'unknown branch'} at ${i.commit.slice(0, 12)}` : 'version not known');

/**
 * The context of a report, masked, as Markdown lines. Never the job's item: its repository, title and text may be
 * private, so only the person adds them.
 */
export function reportContext(i: ReportContextInput): string {
  const lines = [
    `- Hopper: ${versionOf(i.install)}`,
    `- Install: ${i.install.kind === 'image' ? 'container' : 'host'}`,
    `- System: ${i.system.platform} ${i.system.release} (${i.system.arch}), Node ${i.system.node}`,
  ];
  const job = i.job;
  if (job) {
    lines.push(`- Job: ${job.id} (${STATE_WORDS[job.status]})`);
    if (i.failureId) lines.push(`- Failure: ${i.failureId}`);
    if (i.signature) lines.push(`- ${SIGNATURE_LINE}${i.signature}`);
    if (job.error) lines.push(`- Error: ${job.error.split('\n')[0]!.slice(0, 500)}`);
    const tail = job.errorTail?.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
    if (tail) lines.push('', `Last ${TAIL_LINES} log lines of the job:`, '', '```text', tail.replaceAll('```', "'''"), '```');
  }
  return maskReportText(lines.join('\n'), i.system.hostname);
}

export interface ReportText {
  happened: string;
  expected: string;
  context: string;
  /** The job that files it (`hopper-report`), marked as the job's. */
  fromJob?: string;
}

/** A report's body: the person's sections, those with text, and the hopper's note; GitHub tokens and keys always masked. */
export function reportBody(r: ReportText): string {
  const sections = [['What happened', r.happened], ['What I expected', r.expected], ['Context', r.context]]
    .filter(([, text]) => text!.trim() !== '')
    .map(([heading, text]) => `### ${heading}\n\n${text!.trim()}`);
  const note = r.fromJob ? `Filed by a job (${r.fromJob}) with Report a bug in a hopper.` : 'Filed with Report a bug in a hopper.';
  return maskKeys(maskGitHubTokens(`${sections.join('\n\n')}\n\n---\n${note}`));
}

/** A report's title, tokens and keys masked. */
export const reportTitle = (title: string): string => maskKeys(maskGitHubTokens(title.trim()));

const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'are', 'was', 'not', 'but', 'its', 'has', 'have']);
const MAX_TERMS = 6;

/** The words of a title the duplicate search looks for: three letters or more, no common words, at most six. */
export function searchTerms(title: string): string[] {
  const words = title.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** The share of the terms that a title has: 1 when it has all. */
export function similarityOf(terms: string[], title: string): number {
  if (terms.length === 0) return 0;
  const words = new Set(title.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  return terms.filter((t) => words.has(t)).length / terms.length;
}
