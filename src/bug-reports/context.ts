// Report a bug (issue #694, design.md "Report a bug"), pure: the context a report carries — the System line only (issue
// #2478) — masked before the person sees it; the report's body; and the terms of the duplicate search.
import { maskAddresses, maskGitHubTokens, maskKeys, maskSecret } from '../secrets/mask.ts';

/** Where every report goes: the hopper's own repository. */
export const REPORT_REPO = 'henningfutrell/hopper';
/** The one label a report gets: never `hopper`, so a report never starts a job (issue #655 is the gate for the rest). */
export const REPORT_LABEL = 'user-report';

/** The machine the hopper runs on, as the context names it. */
export interface ReportSystem { platform: string; release: string; arch: string; node: string; hostname: string }

/** Text as a report may carry it: tokens, keys, the host name, IP addresses, private host names and home directories masked. */
export function maskReportText(text: string, hostname?: string): string {
  return maskAddresses(maskKeys(maskGitHubTokens(maskSecret(text, hostname, 'host'))));
}

/**
 * The context of a report, masked: the System line and nothing else (issue #2478). Never the hopper's version, its
 * install type or a job: they do not belong in a public issue.
 */
export function reportContext(system: ReportSystem): string {
  return maskReportText(`- System: ${system.platform} ${system.release} (${system.arch}), Node ${system.node}`, system.hostname);
}

export interface ReportText {
  happened: string;
  expected: string;
  context: string;
  /** A job files it (`hopper-gh report bug`): marked as a job's, with no job id. */
  fromJob?: boolean;
}

/** A report's body: the person's sections, those with text, and the hopper's note; GitHub tokens and keys always masked. */
export function reportBody(r: ReportText): string {
  const sections = [['What happened', r.happened], ['What I expected', r.expected], ['Context', r.context]]
    .filter(([, text]) => text!.trim() !== '')
    .map(([heading, text]) => `### ${heading}\n\n${text!.trim()}`);
  const note = r.fromJob ? 'Filed by a job with Report a bug in a hopper.' : 'Filed with Report a bug in a hopper.';
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
