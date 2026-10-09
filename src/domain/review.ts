// Review sections (issue #543, design.md "Sections"): Proposals (issue #537) and Research (issue #538). A job asked for
// one writes a document instead of doing the work — a proposal, a research report — and ends its message with the
// section's marker. The document is a review item: it climbs the reviewer levels the section's settings name, then
// reaches a person, who decides with one of the decisions the section declares; a decision accepts it, rejects it, or
// sends it back to the same job for the next version. One model for every review section: each is declared once,
// here, by its ReviewSectionType, and a future one follows the same path. Pure: no I/O. Re-exported from types.ts.
import type { ShiftThen } from './phase.ts';
import type { JobId, PriorityTag, RaisedBy } from './types.ts';

/**
 * The review kinds, in the order a job asking for several does them (the orchestration loop): research first, then
 * the proposal it informs.
 */
export const REVIEW_KINDS = ['research', 'proposal'] as const;
export type ReviewKind = typeof REVIEW_KINDS[number];

/**
 * `open`: in review, at `stage`. `revising`: sent back; the job writes the next version. `accepted`, `rejected`: signed
 * off. `cancelled`: its job ended or was dismissed before a decision.
 */
export const REVIEW_STATUSES = ['open', 'revising', 'accepted', 'rejected', 'cancelled'] as const;
export type ReviewStatus = typeof REVIEW_STATUSES[number];

/** Still waits on a decision: a reviewer level or a person, or the job's next version. */
export const REVIEW_OPEN_STATUSES: readonly ReviewStatus[] = ['open', 'revising'];

/**
 * A reviewer level's verdict: `approve` (it makes sense: on to the next level, or accepted where this level may sign
 * off), `request_changes` (back to the job with the reasons), `escalate` (it cannot judge: the next level up).
 */
export const REVIEW_VERDICTS = ['approve', 'request_changes', 'escalate'] as const;
export type ReviewVerdict = typeof REVIEW_VERDICTS[number];

/** Every decision a person may take on a review item, in any section; each section declares which it offers. */
export const REVIEW_DECISIONS = ['accept', 'reject', 'request_changes', 'dig_deeper', 'steer'] as const;
export type ReviewDecisionId = typeof REVIEW_DECISIONS[number];

/** What a decision does: signs the item off accepted or rejected, or sends it back to its job for the next version. */
export type ReviewEffect = 'accept' | 'reject' | 'send_back';

/** A decision a section offers a person: its route (`POST /ui/api/<section>/:id/<route>`), its label, its effect, and whether it needs notes. */
export interface ReviewDecision { id: ReviewDecisionId; route: string; label: string; effect: ReviewEffect; notes: 'optional' | 'required' }

/** One part of a review item's document: its key, the label the agent writes it with, and other labels read as it. */
export interface ReviewPart { id: string; label: string; aliases?: readonly string[] }

/** One version of a review item: the first, or the next after it was sent back (a research report's round). */
export interface ReviewVersion {
  /** 1 for the first. */
  number: number;
  /** The document as the agent wrote it. */
  text: string;
  /** Its parts, read from the text; a part the agent left out is absent. */
  sections: Record<string, string>;
  /** The parts it left out, in order. */
  missing: string[];
  recentOutput: string;
  at: string;
}

/** One entry in a review item's trail: a reviewer level's verdict, or a person's decision. */
export interface ReviewEntry {
  /** The version it reviewed. */
  version: number;
  /** Who: the reviewer level's instance name, or `human`. */
  stage: string;
  role: 'level' | 'human';
  /** A level's verdict (an error escalates), or a person's decision. */
  verdict: ReviewVerdict | ReviewDecisionId;
  /** Why; for a decision that sends it back, what the job is told. */
  notes: string;
  /** The person, by name, for a person's decision. */
  by?: string;
  model?: string;
  machine?: { id: string; why: string };
  error?: string;
  startedAt: string;
  finishedAt: string;
}

/** Who signed a review item off, and when. */
export interface ReviewSignOff {
  decision: 'accept' | 'reject';
  /** The reviewer level that signed off, or `human`. */
  stage: string;
  /** The person, by name; absent for a level. */
  by?: string;
  at: string;
  /** The version signed off. */
  version: number;
  notes?: string;
  /** Accepted in a switched phase (issue #548): what the person picked for the job next. */
  then?: ShiftThen;
}

/** A proposal or a research report: one per job and kind, its versions and review trail in it. */
export interface ReviewItem {
  id: string;
  kind: ReviewKind;
  jobId: JobId;
  status: ReviewStatus;
  /** The stage holding it (or the last one): a reviewer level's instance name, or `human`. */
  stage: string;
  /** Every version, oldest first. */
  versions: ReviewVersion[];
  reviews: ReviewEntry[];
  /** How often the reviewer levels sent it back. */
  levelRevisions: number;
  signOff?: ReviewSignOff;
  /** Where it was written. */
  raisedBy?: RaisedBy;
  /** Where its job was pulled from: kept with the item (what it becomes is linked to it later). A fork's: its parent's. */
  source?: { key: string; url?: string; title?: string };
  /** Written by a fork (issue #548): the job and question it was forked from. */
  forkOf?: { jobId: JobId; questionId: string };
  /** Written in a switched phase (issue #548): the job's question it switched from. */
  switchedFrom?: { jobId: JobId; questionId: string };
  /** When a person first saw it in the UI. */
  seenAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * A review item as the routes answer it: with its job's live priority (issue #535), and, while its job is in a switched
 * phase of its kind, what a person may pick for the job at Accept (issue #548).
 */
export type ReviewItemView = ReviewItem & PriorityTag & { then?: ShiftThen[] };

/** Who may accept a review item: only a person, or the top reviewer level too (its approval accepts). */
export const REVIEW_SIGN_OFF = ['owner', 'top-level'] as const;
export type ReviewSignOffBy = typeof REVIEW_SIGN_OFF[number];

/** The most times the reviewer levels may send one item back before it goes to a person. */
export const MAX_LEVEL_REVISIONS = 5;

/**
 * A review section's settings, the user's, read at each review so a change applies without a restart. `reviewers`:
 * the escalation levels that review, lowest first, by instance name; none: a person reviews. `signOff`: who may
 * accept. `levelRevisions`: how often the levels may send one item back before it goes to a person.
 */
export interface ReviewSettings { reviewers: string[]; signOff: ReviewSignOffBy; levelRevisions: number }
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { reviewers: [], signOff: 'owner', levelRevisions: 1 };

/** The settings and what may be chosen for them: the escalation levels there are now. */
export interface ReviewSettingsView extends ReviewSettings { levels: string[] }

/** What a review section declares to the UI, so it offers exactly what the server takes: its parts and decisions. */
export interface ReviewSectionView { parts: [string, string][]; decisions: ReviewDecision[] }

/** A review section's type: everything that makes Proposals Proposals and Research Research. */
export interface ReviewSectionType {
  kind: ReviewKind;
  /** The section it is listed in (the nav entry, `/api/<section>`, `/ui/api/<section>/...`). */
  section: 'proposals' | 'research';
  /** What one item is called. */
  noun: string;
  /** Its events: `<prefix>.submitted` and the rest. */
  prefix: 'proposal' | 'research';
  /** The field naming the item on its events. */
  idField: 'proposalId' | 'researchId';
  /** The job's field naming its item of this kind (the job waits on it while it is open). */
  jobField: 'proposalId' | 'researchId';
  /** The job spec's flag: the job is asked for one. */
  specFlag: 'proposal' | 'research';
  /** The marker an agent ends the document with. */
  marker: string;
  /** The source item label that asks for one. */
  label: string;
  /** The body heading that asks for one (the layout of issue #542): `## Research`, `## Proposal`. */
  heading: string;
  /** `POST /ui/api/jobs/:id/<askPath>`: a person asks a job that has not started for one. */
  askPath: string;
  parts: readonly ReviewPart[];
  decisions: readonly ReviewDecision[];
  /** The protocol line every job is told: how to come back with one. */
  protocol: string;
  /** What a job asked for one is told after its job rules. */
  ask: string;
  /** What a job is told when its item is sent back by `from` (`human` or a reviewer level) with `decision` and `notes`. */
  brief(item: ReviewItem, from: string, decision: ReviewDecisionId, notes: string): string;
  /** What a reviewer level is asked to check, in its prompt. */
  check: string;
  /**
   * Accepted, whether a job that was not asked for one goes on in its session with the rest of its own work, or ends
   * done (issue #538: research); false: the decision ends the job (a proposal, issue #537).
   */
  goesOn: boolean;
}

const PROPOSAL_PARTS: readonly ReviewPart[] = [
  { id: 'goal', label: 'Goal' }, { id: 'approach', label: 'Approach' }, { id: 'alternatives', label: 'Alternatives considered', aliases: ['Alternatives'] },
  { id: 'risks', label: 'Risks' }, { id: 'effort', label: 'Effort' }, { id: 'context', label: 'Context' },
];
const RESEARCH_PARTS: readonly ReviewPart[] = [
  { id: 'question', label: 'Question' }, { id: 'findings', label: 'Findings' }, { id: 'sources', label: 'Sources and evidence', aliases: ['Sources', 'Evidence'] },
  { id: 'confidence', label: 'Confidence' }, { id: 'openThreads', label: 'Open threads' }, { id: 'nextStep', label: 'Next step', aliases: ['Suggested next step'] },
];
const labelled = (parts: readonly ReviewPart[]): string => parts.map((p) => `${p.label}:`).join(', ');
const whoOf = (from: string): string => (from === 'human' ? 'a person' : `the reviewer level ${from}`);

export const REVIEW_SECTIONS: Readonly<Record<ReviewKind, ReviewSectionType>> = {
  research: {
    kind: 'research', section: 'research', noun: 'research report', prefix: 'research', idField: 'researchId', jobField: 'researchId', specFlag: 'research',
    marker: 'HOPPER_RESEARCH_REPORT', label: 'hopper:research', heading: 'research', askPath: 'research',
    parts: RESEARCH_PARTS,
    decisions: [
      { id: 'accept', route: 'accept', label: 'Accept', effect: 'accept', notes: 'optional' },
      { id: 'dig_deeper', route: 'dig-deeper', label: 'Dig deeper', effect: 'send_back', notes: 'optional' },
      { id: 'steer', route: 'steer', label: 'Steer', effect: 'send_back', notes: 'required' },
    ],
    protocol: `When you are asked to research, do not do the work: research, then write a research report in Simplified Technical English (ASD-STE100), each part on a line of its own starting with its label — ${labelled(RESEARCH_PARTS)} — and end your message with a line containing only: HOPPER_RESEARCH_REPORT. A person accepts it, asks you to dig deeper, or steers you; you keep your session meanwhile.`,
    ask: '[hopper research] This job asks you to research, not to do the work: answer the research questions it names (the items under its Research heading, if it has one), then write the research report as the protocol says, in Simplified Technical English (ASD-STE100), and end with HOPPER_RESEARCH_REPORT. Change nothing, and open no pull request.',
    brief: (item, from, decision, notes) => [
      `[hopper research] Your research report (round ${item.versions.length}) was reviewed by ${whoOf(from)}.`,
      decision === 'steer' ? `Steer: ${notes}` : decision === 'request_changes' ? `What to change: ${notes}` : `Dig deeper: ${notes || 'go deeper on the whole report.'}`,
      'Continue the same research in this session, then write the whole report again, as before, and end with HOPPER_RESEARCH_REPORT.',
    ].join('\n'),
    check: 'Check whether the research report answers the question the job asks: are the findings backed by the sources and evidence it names, is the confidence it states earned, are the open threads the real ones, and does the next step follow.',
    goesOn: true,
  },
  proposal: {
    kind: 'proposal', section: 'proposals', noun: 'proposal', prefix: 'proposal', idField: 'proposalId', jobField: 'proposalId', specFlag: 'proposal',
    marker: 'HOPPER_PROPOSAL', label: 'hopper:proposal', heading: 'proposal', askPath: 'propose',
    parts: PROPOSAL_PARTS,
    decisions: [
      { id: 'accept', route: 'accept', label: 'Accept', effect: 'accept', notes: 'optional' },
      { id: 'request_changes', route: 'request-changes', label: 'Request changes', effect: 'send_back', notes: 'required' },
      { id: 'reject', route: 'reject', label: 'Reject', effect: 'reject', notes: 'required' },
    ],
    protocol: 'When you are asked for a proposal, do not do the work: write the proposal in Simplified Technical English (ASD-STE100), each part on a line of its own starting with its label — Goal:, Approach:, Alternatives considered:, Risks:, Effort:, Context: (what you read and relied on) — and end your message with a line containing only: HOPPER_PROPOSAL. It is reviewed; you are told whether it was accepted, or what to change.',
    ask: '[hopper proposal] This job asks you for a proposal, not for the work: read what you need, then write the proposal as the protocol says, in Simplified Technical English (ASD-STE100), and end with HOPPER_PROPOSAL. Change nothing, and open no pull request.',
    brief: (item, from, _decision, notes) => [
      `[hopper proposal] Your proposal (version ${item.versions.length}) was sent back by ${whoOf(from)}. What to change:`,
      notes,
      'Write the revised proposal in full, as before, and end with HOPPER_PROPOSAL.',
    ].join('\n'),
    check: 'Check whether the proposal makes sense for the job: does it serve the goal the job states, is the approach sound and the smallest that does it, were the real alternatives weighed, are the risks named and the effort believable, and does the context it relied on hold up.',
    goesOn: false,
  },
};

/** The review kind whose section is `section`, if it is a review section. */
export const reviewKindOf = (section: string): ReviewKind | undefined => REVIEW_KINDS.find((k) => REVIEW_SECTIONS[k].section === section);

/** What a section declares to the UI. */
export const reviewSectionView = (kind: ReviewKind): ReviewSectionView =>
  ({ parts: REVIEW_SECTIONS[kind].parts.map((p): [string, string] => [p.id, p.label]), decisions: REVIEW_SECTIONS[kind].decisions.map((d) => ({ ...d })) });

/** The review kinds a job spec asks for, in the order the job does them. */
export const asksOfSpec = (spec: { proposal?: true; research?: true }): ReviewKind[] => REVIEW_KINDS.filter((k) => spec[REVIEW_SECTIONS[k].specFlag] === true);

/** A markdown heading line's words, lowercased: `## Research` → `research`; any other line → undefined. */
const headingOf = (line: string): string | undefined => /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]!.replace(/[*_`]/g, '').trim().toLowerCase();

/**
 * What a source item asks for (issue #543): a section's label, or a heading of that section in its body (the layout
 * of issue #542: `## Proposal`, `## Research`, `## Special jobs`), in the order the job does them.
 */
export function asksOf(labels: readonly string[], body: string): ReviewKind[] {
  const headings = new Set(body.split('\n').map(headingOf).filter((h): h is string => h !== undefined));
  return REVIEW_KINDS.filter((k) => labels.includes(REVIEW_SECTIONS[k].label) || headings.has(REVIEW_SECTIONS[k].heading));
}

function labelMap(kind: ReviewKind): Map<string, string> {
  return new Map(REVIEW_SECTIONS[kind].parts.flatMap((p) => [p.label, ...(p.aliases ?? [])].map((l): [string, string] => [l.toLowerCase(), p.id])));
}

/** A line that starts a part: its label (heading, list or emphasis marks aside), a colon, and maybe its first words. */
function partStart(labels: Map<string, string>, line: string): { part: string; rest: string } | undefined {
  const m = /^[\s#>*•-]*\**_*([A-Za-z][A-Za-z ]*?)_*\**\s*:\s*\**_*\s*(.*)$/.exec(line);
  if (m) {
    const part = labels.get(m[1]!.trim().toLowerCase());
    return part ? { part, rest: m[2]!.trim() } : undefined;
  }
  // A heading on its own line: `## Goal` (a terminal may show it as `Goal`).
  const h = /^[\s#*]*([A-Za-z][A-Za-z ]*?)[\s*]*$/.exec(line);
  const part = h ? labels.get(h[1]!.trim().toLowerCase()) : undefined;
  return part ? { part, rest: '' } : undefined;
}

/** The parts of a review item's text, each from its label to the next; a part said twice keeps both. */
export function reviewSections(kind: ReviewKind, text: string): { sections: Record<string, string>; missing: string[] } {
  const labels = labelMap(kind);
  const found = new Map<string, string[]>();
  let current: string | undefined;
  for (const line of text.split('\n')) {
    const start = partStart(labels, line);
    if (start) {
      current = start.part;
      const lines = found.get(current) ?? [];
      if (start.rest) lines.push(start.rest);
      found.set(current, lines);
    } else if (current) {
      found.get(current)!.push(line);
    }
  }
  const sections: Record<string, string> = {};
  for (const { id } of REVIEW_SECTIONS[kind].parts) {
    const body = found.get(id)?.join('\n').trim();
    if (body) sections[id] = body;
  }
  return { sections, missing: REVIEW_SECTIONS[kind].parts.map((p) => p.id).filter((id) => sections[id] === undefined) };
}
