// Proposals (issue #537, design.md "Proposals"): a job asked for a proposal writes one instead of doing the work, and
// ends its message with HOPPER_PROPOSAL. The proposal climbs the reviewer levels, then reaches a person, who accepts
// it, rejects it or sends it back for a revision. Apart from questions: a proposal is never a question. Pure: no I/O.
// Re-exported from types.ts.
import type { JobId, PriorityTag, RaisedBy } from './types.ts';

/** The marker an agent ends a proposal with. */
export const PROPOSAL_MARKER = 'HOPPER_PROPOSAL';

/** The label that asks a source item's job for a proposal. */
export const PROPOSAL_LABEL = 'hopper:proposal';

/** The parts of a proposal, in the order the agent writes them. */
export const PROPOSAL_SECTIONS = ['goal', 'approach', 'alternatives', 'risks', 'effort', 'context'] as const;
export type ProposalSection = typeof PROPOSAL_SECTIONS[number];
export type ProposalSections = Partial<Record<ProposalSection, string>>;

/** Each part's label, as the agent writes it at the start of a line. */
export const PROPOSAL_SECTION_LABELS: Readonly<Record<ProposalSection, string>> = {
  goal: 'Goal', approach: 'Approach', alternatives: 'Alternatives considered', risks: 'Risks', effort: 'Effort', context: 'Context',
};

/**
 * `open`: in review, at `stage`. `revising`: sent back; the job writes the next version. `accepted`, `rejected`: signed
 * off. `cancelled`: its job ended or was dismissed before a decision.
 */
export const PROPOSAL_STATUSES = ['open', 'revising', 'accepted', 'rejected', 'cancelled'] as const;
export type ProposalStatus = typeof PROPOSAL_STATUSES[number];

/** Still waits on a decision: a reviewer level or a person, or the job's revision. */
export const PROPOSAL_OPEN_STATUSES: readonly ProposalStatus[] = ['open', 'revising'];

/**
 * A reviewer level's verdict: `approve` (it makes sense: on to the next level, or accepted where this level may sign
 * off), `request_changes` (back to the job with the reasons), `escalate` (it cannot judge: the next level up).
 */
export const REVIEW_VERDICTS = ['approve', 'request_changes', 'escalate'] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];

/** What a person decides: accept, reject, or request changes. */
export const PROPOSAL_DECISIONS = ['accept', 'reject', 'request_changes'] as const;
export type ProposalDecision = typeof PROPOSAL_DECISIONS[number];

/** One version of a proposal: the first, or a revision. */
export interface ProposalVersion {
  /** 1 for the first. */
  number: number;
  /** The proposal as the agent wrote it. */
  text: string;
  /** Its parts, read from the text; a part the agent left out is absent. */
  sections: ProposalSections;
  /** The parts it left out, in order. */
  missing: ProposalSection[];
  recentOutput: string;
  at: string;
}

/** One entry in a proposal's review trail: a reviewer level's verdict, or a person's decision. */
export interface ProposalReview {
  /** The version it reviewed. */
  version: number;
  /** Who: the reviewer level's instance name, or `human`. */
  stage: string;
  role: 'level' | 'human';
  /** A level's verdict (an error escalates), or a person's decision. */
  verdict: ReviewVerdict | ProposalDecision;
  /** Why; for `request_changes`, what to change: the job is told it. */
  notes: string;
  /** The person, by name, for a person's decision. */
  by?: string;
  model?: string;
  machine?: { id: string; why: string };
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Who signed a proposal off, and when. */
export interface ProposalSignOff {
  decision: 'accept' | 'reject';
  /** The reviewer level that signed off, or `human`. */
  stage: string;
  /** The person, by name; absent for a level. */
  by?: string;
  at: string;
  /** The version signed off. */
  version: number;
  notes?: string;
}

export interface Proposal {
  id: string;
  jobId: JobId;
  status: ProposalStatus;
  /** The stage holding it (or the last one): a reviewer level's instance name, or `human`. */
  stage: string;
  /** Every version, oldest first. */
  versions: ProposalVersion[];
  reviews: ProposalReview[];
  /** How often the reviewer levels sent it back. */
  levelRevisions: number;
  signOff?: ProposalSignOff;
  /** Where it was written. */
  raisedBy?: RaisedBy;
  /** Where its job was pulled from: kept with the proposal (an accepted proposal's work is linked to it later). */
  source?: { key: string; url?: string; title?: string };
  /** When a person first saw it in the UI. */
  seenAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A proposal as the routes answer it: with its job's live priority (issue #535). */
export type ProposalView = Proposal & PriorityTag;

/** Who may accept a proposal: only a person, or the top reviewer level too (its approval accepts). */
export const PROPOSAL_SIGN_OFF = ['owner', 'top-level'] as const;
export type ProposalSignOffBy = typeof PROPOSAL_SIGN_OFF[number];

/** The most times the reviewer levels may send one proposal back before it goes to a person. */
export const MAX_LEVEL_REVISIONS = 5;

/**
 * The proposal settings, the user's, read at each review so a change applies without a restart. `reviewers`: the
 * escalation levels that review, lowest first, by instance name; none: a person reviews. `signOff`: who may accept.
 * `levelRevisions`: how often the levels may send one proposal back before it goes to a person.
 */
export interface ProposalSettings { reviewers: string[]; signOff: ProposalSignOffBy; levelRevisions: number }
export const DEFAULT_PROPOSAL_SETTINGS: ProposalSettings = { reviewers: [], signOff: 'owner', levelRevisions: 1 };

/** The settings and what may be chosen for them: the escalation levels there are now. */
export interface ProposalSettingsView extends ProposalSettings { levels: string[] }

const LABELS = new Map(PROPOSAL_SECTIONS.flatMap((s): [string, ProposalSection][] => [[PROPOSAL_SECTION_LABELS[s].toLowerCase(), s]]).concat([['alternatives', 'alternatives']]));

/** A line that starts a part: its label (heading, list or emphasis marks aside), a colon, and maybe its first words. */
function sectionStart(line: string): { section: ProposalSection; rest: string } | undefined {
  const m = /^[\s#>*•-]*\**_*([A-Za-z][A-Za-z ]*?)_*\**\s*:\s*\**_*\s*(.*)$/.exec(line);
  if (m) {
    const section = LABELS.get(m[1]!.trim().toLowerCase());
    return section ? { section, rest: m[2]!.trim() } : undefined;
  }
  // A heading on its own line: `## Goal` (a terminal may show it as `Goal`).
  const h = /^[\s#*]*([A-Za-z][A-Za-z ]*?)[\s*]*$/.exec(line);
  const section = h ? LABELS.get(h[1]!.trim().toLowerCase()) : undefined;
  return section ? { section, rest: '' } : undefined;
}

/** The parts of a proposal's text, each from its label to the next; a part said twice keeps both. */
export function proposalSections(text: string): { sections: ProposalSections; missing: ProposalSection[] } {
  const parts = new Map<ProposalSection, string[]>();
  let current: ProposalSection | undefined;
  for (const line of text.split('\n')) {
    const start = sectionStart(line);
    if (start) {
      current = start.section;
      const lines = parts.get(current) ?? [];
      if (start.rest) lines.push(start.rest);
      parts.set(current, lines);
    } else if (current) {
      parts.get(current)!.push(line);
    }
  }
  const sections: ProposalSections = {};
  for (const s of PROPOSAL_SECTIONS) {
    const body = parts.get(s)?.join('\n').trim();
    if (body) sections[s] = body;
  }
  return { sections, missing: PROPOSAL_SECTIONS.filter((s) => sections[s] === undefined) };
}
