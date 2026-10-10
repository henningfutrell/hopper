// A proposal is a set of paths (issue #651, design.md "Proposals: a set of paths"): a short problem statement and 0..N
// alternative strategies, each with its title, its TL;DR, its tradeoffs and what continuing with it creates. The agent
// marks one path, or several, recommended and says why. Zero paths is valid when it says why: no change is needed, or no
// viable path was found. A person selects one or more paths, each with a note; each selected path continues on its own,
// as a follow-on job. A proposal written before paths (Goal:, Approach:, ...) reads as one path. Pure: no I/O.
// Re-exported from types.ts.

/** A path's tradeoffs, in the order the card shows them. */
export const PATH_TRADEOFFS = ['security', 'effort', 'risk', 'friction'] as const;
export type PathTradeoff = typeof PATH_TRADEOFFS[number];

/** One path of a proposal. */
export interface ProposalPath {
  /** Its number, as the agent wrote it (`Path 2:` → `2`): kept from one version to the next. */
  id: string;
  title: string;
  /** Its TL;DR: one or two sentences. */
  summary?: string;
  /** Security, effort, risk, friction for the person; a tradeoff the agent left out is absent. */
  tradeoffs: Partial<Record<PathTradeoff, string>>;
  /** What continuing with it creates: jobs, issues, research. */
  creates?: string;
  /** The whole path as the agent wrote it, as Markdown. */
  text: string;
  /** The agent recommends it, alone or in a combination. */
  recommended?: true;
  /** A reviewer level added it (issue #651): the level's instance name. */
  addedBy?: string;
  /** A reviewer level found it not viable, and why: it cannot be selected. */
  notViable?: { by: string; why: string };
}

/**
 * A proposal version's paths. `none`: why there is no path (no change is needed, or no viable path was found).
 * `recommendation`: why the recommended path or combination. `single`: the version was not written as paths (a
 * proposal from before them, or one that left the format): the whole document reads as its one path.
 */
export interface ProposalPathSet { paths: ProposalPath[]; recommendation?: string; none?: string; single?: true }

/** A path a person selected, with their note. */
export interface PathPick { id: string; note?: string }

/** A selected path once the proposal was accepted: its title, the person's note, and the follow-on job it continues as. */
export interface SelectedPath extends PathPick { title: string; jobId?: string }

/** What a person had selected before they asked for more paths or steered (issue #651): kept for the next version. */
export interface PathSelection { version: number; paths: PathPick[] }

/** A follow-on of an accepted proposal, as the proposal shows it: its path, its job and the job's live status. */
export interface FollowOnView { pathId: string; jobId: string; jobStatus: string }

/**
 * A follow-on job's link (issue #651): the job and proposal it came from, the path it continues and the person's
 * note. Like a fork, it has no source of its own: the parent's item is named here, and the sync never reports the
 * follow-on to it.
 */
export interface FollowOnOf {
  jobId: string;
  proposalId: string;
  pathId: string;
  title: string;
  /** The path as written, as the follow-on is told it. */
  text: string;
  note?: string;
  /** The other paths selected with it: each runs as its own job. */
  siblings: string[];
  source?: { source: string; kind: string; key: string; url?: string; title?: string; repo?: string };
}

/** A path a reviewer level adds (issue #651). */
export interface PathDraft { title: string; summary: string; tradeoffs?: Partial<Record<PathTradeoff, string>>; creates?: string }

/** A reviewer level's changes to the paths before a person sees them. */
export interface PathAmendments { add?: PathDraft[]; notViable?: { id: string; why: string }[] }

const TOP_LABELS: Readonly<Record<string, string>> = {
  'tl;dr': 'tldr', tldr: 'tldr', problem: 'problem', 'problem statement': 'problem', paths: 'paths',
  recommended: 'recommended', recommendation: 'recommended', context: 'context',
};
const PATH_LABELS: Readonly<Record<string, string>> = {
  summary: 'summary', 'tl;dr': 'summary', tldr: 'summary', security: 'security', effort: 'effort', risk: 'risk', risks: 'risk',
  friction: 'friction', 'friction for the person': 'friction', creates: 'creates', 'what it creates': 'creates',
};

/** A labelled line: its label (heading, list or emphasis marks aside), lowercased, and the words after the colon. */
function labelled(line: string): { label: string; rest: string } | undefined {
  const m = /^[\s#>*•-]*\**_*([A-Za-z][A-Za-z ;]*?)_*\**\s*:\s*\**_*\s*(.*)$/.exec(line);
  if (m) return { label: m[1]!.trim().toLowerCase(), rest: m[2]!.trim() };
  // A heading on its own line: `## Problem`.
  const h = /^\s{0,3}#{1,6}\s+([A-Za-z][A-Za-z ;]*?)\s*#*\s*$/.exec(line);
  return h ? { label: h[1]!.trim().toLowerCase(), rest: '' } : undefined;
}

/** A line that starts a path: `Path 2: Spray it`, `## Path 2 — Spray it`, `**Option 2.** Spray it`. */
function pathStart(line: string): { id: string; title: string } | undefined {
  // The number ends the line or a separator follows it: `Path 1 is cheaper` is prose, not a path.
  const m = /^[\s#>*•-]*\**_*(?:path|option)\s+(\d{1,3})_*\**\s*(?:[:.)—–-]\s*\**_*\s*(.*?)\s*\**_*\s*)?$/i.exec(line);
  return m ? { id: String(Number(m[1])), title: (m[2] ?? '').trim() } : undefined;
}

/** `1, 3 — why`, `paths 1 and 2: why`, `Path 2, because ...`, `none — why`: the path numbers and the why. */
export function recommendationOf(text: string): { ids: string[]; why: string; none: boolean } {
  const first = text.split('\n')[0]!;
  const none = /^\s*none\b/i.exec(first);
  if (none) return { ids: [], why: text.replace(/^\s*none\b\s*[—–:,.-]*\s*/i, '').trim(), none: true };
  const m = /^\s*\**(?:(?:paths?|options?)\s*)?((?:\d{1,3}\s*(?:,|\+|&|and|plus|or)?\s*(?:(?:paths?|options?)\s*)?)+)\**/i.exec(first);
  if (!m || !/\d/.test(m[1]!)) return { ids: [], why: text.trim(), none: false };
  const ids = [...new Set([...m[1]!.matchAll(/\d{1,3}/g)].map((x) => String(Number(x[0]))))];
  return { ids, why: text.slice(m[0].length).replace(/^\s*[—–:,.;-]*\s*(?:because\s+)?/i, '').trim(), none: false };
}

interface Draft { id: string; title: string; lines: string[]; fields: Map<string, string[]>; field?: string }

/** The parts a proposal's document declares (REVIEW_SECTIONS.proposal.parts): what a version reads as its sections. */
export interface ProposalDocument { sections: Record<string, string>; missing: string[]; paths: ProposalPathSet }

/**
 * A proposal's document read as paths. Its top parts — TL;DR, Problem, Paths (only to say why there is none),
 * Recommended, Context — each run from their label to the next; each `Path N:` line starts a path, which runs to the
 * next path or top part. A document with no path and no reason for none reads as one path: the whole document
 * (`single`), named by its first line or its Goal.
 */
export function proposalDocument(text: string): ProposalDocument {
  const top = new Map<string, string[]>();
  const drafts: Draft[] = [];
  let current: { kind: 'top'; part: string } | { kind: 'path'; draft: Draft } | undefined;
  for (const line of text.split('\n')) {
    const start = pathStart(line);
    if (start) {
      const draft: Draft = { id: start.id, title: start.title, lines: [], fields: new Map() };
      drafts.push(draft);
      current = { kind: 'path', draft };
      continue;
    }
    const l = labelled(line);
    const topPart = l ? TOP_LABELS[l.label] : undefined;
    if (l && topPart) {
      current = { kind: 'top', part: topPart };
      const lines = top.get(topPart) ?? [];
      if (l.rest) lines.push(l.rest);
      top.set(topPart, lines);
      continue;
    }
    if (current?.kind === 'path') {
      const d = current.draft;
      d.lines.push(line);
      const field = l ? PATH_LABELS[l.label] : undefined;
      if (l && field) {
        d.field = field;
        d.fields.set(field, [...(d.fields.get(field) ?? []), ...(l.rest ? [l.rest] : [])]);
      } else if (line.trim() === '') d.field = undefined;
      else if (d.field) d.fields.get(d.field)!.push(line.trim());
      else if (!d.title) d.title = line.replace(/^[\s#>*•-]+/, '').trim();
    } else if (current?.kind === 'top') top.get(current.part)!.push(line);
  }
  const part = (id: string): string | undefined => top.get(id)?.join('\n').trim() || undefined;
  const sections: Record<string, string> = {};
  for (const id of ['tldr', 'problem', 'paths', 'recommended', 'context']) {
    const body = part(id);
    if (body) sections[id] = body;
  }
  const rec = sections.recommended ? recommendationOf(sections.recommended) : undefined;
  const noneWhy = sections.paths && /^\s*none\b/i.test(sections.paths) ? recommendationOf(sections.paths).why || sections.paths : (rec?.none ? rec.why : undefined);
  const paths: ProposalPath[] = [];
  for (const d of drafts) {
    if (paths.some((p) => p.id === d.id)) continue;
    const field = (f: string): string | undefined => d.fields.get(f)?.join('\n').trim() || undefined;
    const tradeoffs: Partial<Record<PathTradeoff, string>> = {};
    for (const t of PATH_TRADEOFFS) {
      const v = field(t);
      if (v) tradeoffs[t] = v;
    }
    const summary = field('summary');
    const creates = field('creates');
    paths.push({
      id: d.id, title: d.title || `Path ${d.id}`, ...(summary ? { summary } : {}), tradeoffs, ...(creates ? { creates } : {}),
      text: d.lines.join('\n').trim(), ...(rec?.ids.includes(d.id) ? { recommended: true as const } : {}),
    });
  }
  if (paths.length === 0 && noneWhy === undefined) {
    const single = singlePath(text);
    return { sections, missing: missingOf(sections, 0, true), paths: { paths: single ? [single] : [], single: true } };
  }
  const set: ProposalPathSet = {
    paths, ...(paths.length > 0 && rec && !rec.none && rec.why ? { recommendation: rec.why } : {}), ...(paths.length === 0 ? { none: noneWhy! } : {}),
  };
  return { sections, missing: missingOf(sections, paths.length, false), paths: set };
}

function missingOf(sections: Record<string, string>, paths: number, single: boolean): string[] {
  const missing: string[] = [];
  if (!sections.tldr) missing.push('tldr');
  if (!sections.problem) missing.push('problem');
  if (single) missing.push('paths');
  if (paths > 0 && !sections.recommended) missing.push('recommended');
  if (!sections.context) missing.push('context');
  return missing;
}

/** The parts of a proposal written before paths (issue #537), as its one path reads them. */
const LEGACY = /^[\s#>*•-]*\**_*(Goal|Approach|Alternatives considered|Alternatives|Risks|Effort|Context)_*\**\s*:\s*\**_*\s*(.*)$/i;

/** A document not written as paths, as one path: titled by its Goal or its first line; its Risks and Effort as tradeoffs. */
function singlePath(text: string): ProposalPath | undefined {
  const body = text.trim();
  if (!body) return undefined;
  const parts = new Map<string, string>();
  let at: string | undefined;
  for (const line of body.split('\n')) {
    const m = LEGACY.exec(line);
    if (m) { at = m[1]!.toLowerCase(); parts.set(at, m[2]!.trim()); } else if (at && line.trim()) parts.set(at, `${parts.get(at)}\n${line.trim()}`.trim());
  }
  const title = parts.get('goal') ?? body.split('\n')[0]!.replace(/^[\s#>*•-]+/, '').trim().slice(0, 200);
  const tradeoffs: Partial<Record<PathTradeoff, string>> = {};
  if (parts.get('risks')) tradeoffs.risk = parts.get('risks')!;
  if (parts.get('effort')) tradeoffs.effort = parts.get('effort')!;
  const summary = parts.get('approach');
  return { id: '1', title, ...(summary ? { summary } : {}), tradeoffs, text: body, recommended: true };
}

/** A version's paths: the ones read when it was written (and amended by the levels), else read from its text now. */
export const pathsOf = (v: { text: string; paths?: ProposalPathSet }): ProposalPathSet => v.paths ?? proposalDocument(v.text).paths;

/** The paths a person may select: every path no reviewer level found not viable. */
export const viablePaths = (set: ProposalPathSet): ProposalPath[] => set.paths.filter((p) => !p.notViable);

/** Why `picks` is no selection a person may continue with on `set`, or undefined. */
export function selectionRefusal(set: ProposalPathSet, picks: readonly PathPick[] | undefined, accept: boolean): string | undefined {
  const viable = viablePaths(set);
  const list = picks ?? [];
  if (accept && viable.length === 0 && list.length > 0) return 'this proposal has no path to select: accept it, steer it, or ask for paths';
  if (accept && viable.length > 0 && list.length === 0) return 'select at least one path to continue with';
  const seen = new Set<string>();
  for (const p of list) {
    if (seen.has(p.id)) return `path ${p.id} is selected twice`;
    seen.add(p.id);
    const path = set.paths.find((x) => x.id === p.id);
    if (!path) return `the proposal has no path ${p.id} (its paths: ${set.paths.map((x) => x.id).join(', ') || 'none'})`;
    if (path.notViable) return `path ${p.id} is not viable: ${path.notViable.why}`;
  }
  return undefined;
}

/** `set` with a reviewer level's amendments: paths it found not viable marked, paths it added numbered after the last. */
export function amendPaths(set: ProposalPathSet, a: PathAmendments, by: string): { set: ProposalPathSet; added: string[]; notViable: string[] } {
  const why = new Map((a.notViable ?? []).map((n) => [n.id, n.why]));
  const notViable = set.paths.filter((p) => why.has(p.id) && !p.notViable).map((p) => p.id);
  const paths = set.paths.map((p) => (notViable.includes(p.id) ? { ...p, notViable: { by, why: why.get(p.id)! } } : p));
  let next = paths.reduce((n, p) => Math.max(n, Number(p.id) || 0), 0);
  const added: string[] = [];
  for (const d of a.add ?? []) {
    const id = String(++next);
    added.push(id);
    const tradeoffs = Object.fromEntries(PATH_TRADEOFFS.flatMap((t) => (d.tradeoffs?.[t] ? [[t, d.tradeoffs[t]]] : []))) as Partial<Record<PathTradeoff, string>>;
    const text = [`**${d.title}**`, '', d.summary, ...PATH_TRADEOFFS.flatMap((t) => (tradeoffs[t] ? [`${t[0]!.toUpperCase()}${t.slice(1)}: ${tradeoffs[t]}`] : [])), ...(d.creates ? [`Creates: ${d.creates}`] : [])].join('\n');
    paths.push({ id, title: d.title, summary: d.summary, tradeoffs, ...(d.creates ? { creates: d.creates } : {}), text, addedBy: by });
  }
  const { single: _single, none, ...rest } = set;
  return { set: { ...rest, paths, ...(paths.length === 0 && none !== undefined ? { none } : {}) }, added, notViable };
}

/** Each structural gap of a version's paths, one fixed line each (the pre-check, issue #631). */
export function pathGaps(set: ProposalPathSet): string[] {
  if (set.single) {
    return ['Not written as paths: write each alternative as "Path N: <title>" with Summary:, Security:, Effort:, Risk:, Friction: and Creates:, then Recommended:; or write "Paths: none — <why>".'];
  }
  if (set.paths.length === 0) return set.none ? [] : ['No paths and no reason: write "Paths: none — <why>" (no change is needed, or no viable path was found).'];
  const gaps: string[] = [];
  for (const p of set.paths) {
    const left = [!p.summary ? 'Summary:' : '', ...PATH_TRADEOFFS.map((t) => (p.tradeoffs[t] ? '' : `${t[0]!.toUpperCase()}${t.slice(1)}:`)), !p.creates ? 'Creates:' : ''].filter(Boolean);
    if (left.length > 0) gaps.push(`Path ${p.id} (${p.title}) leaves out ${left.join(', ')}.`);
  }
  if (!set.paths.some((p) => p.recommended)) gaps.push('No path is recommended: name the recommended path, or paths, after Recommended:, and say why.');
  return gaps;
}

/** The paths as a person's notes are typed into a job: the selected ones, each with its note. */
export const selectedLines = (selected: readonly SelectedPath[]): string =>
  selected.map((s) => `- Path ${s.id}: ${s.title}${s.note ? ` (note: ${s.note})` : ''}`).join('\n');

/**
 * What a follow-on is told after its job rules (issue #651): the proposal's path it continues, the person's note, and
 * the other selected paths, which run as their own jobs.
 */
export function followOnBrief(f: FollowOnOf): string {
  return [
    `[hopper path] A person accepted a proposal of job ${f.jobId} and selected this path for this job: Path ${f.pathId}: ${f.title}.`,
    ...(f.note ? [`Their note: ${f.note}`] : []),
    f.siblings.length > 0 ? `Other selected paths run as their own jobs; do only this path: ${f.siblings.join('; ')}.` : 'Do only this path.',
    'The path, as the proposal wrote it:',
    f.text,
  ].join('\n');
}
