// Repository memory (issue #2847, design.md "Repository memory"): what earlier jobs of a repository learned — its
// conventions and its past fixes —, kept as memory entries in the user's database and offered to the next jobs of the same
// repository. Pure: the settings record read, a job's memory lines read from its final message, which entries a job is
// offered and the text it is told. The store keeps the entries (src/store/repo-memories.ts); src/repo-memory/ learns,
// offers and edits them.

/** The config record that holds the settings. */
export const REPO_MEMORY = 'repo-memory';

/** What an entry is: a convention of the repository (commands, layout, style, a trap), or a past fix. */
export const MEMORY_KINDS = ['convention', 'fix'] as const;
export type MemoryKind = typeof MEMORY_KINDS[number];

/**
 * Where an entry stands. `proposed`: a job learned it and a person has not approved it. `approved`: offered to jobs.
 * `disabled`: a person took it out of use. `flagged`: a later job said it is wrong; a person approves it again or edits it.
 */
export const MEMORY_STATES = ['proposed', 'approved', 'disabled', 'flagged'] as const;
export type MemoryState = typeof MEMORY_STATES[number];

/** One memory entry of one repository. */
export interface MemoryEntry {
  id: string;
  /** `owner/name`, in lowercase. */
  repo: string;
  kind: MemoryKind;
  /** The part of the repository it is about, a path (`src/store`); absent: the whole repository. */
  area?: string;
  text: string;
  state: MemoryState;
  /** 0 to 1: a person's entry 1; a job's 0.5, and 0.1 more each time a later job learns it again (at most 0.9). */
  confidence: number;
  /** The job that learned it first; absent: a person added it. */
  sourceJobId?: string;
  createdAt: string;
  /** When it was learned again, edited or approved last: an entry older than the settings' `expireDays` expires. */
  updatedAt: string;
  /** Who changed it last: a person, or `job <id>`. */
  by: string;
  /** Why a later job said it is wrong. */
  flag?: { jobId: string; reason: string; at: string };
}

/** The store's memory entries of one user. */
export interface MemoryEntryRepository {
  /** Every entry of `repo` (lowercase), else of every repository, newest change first. */
  list(repo?: string): MemoryEntry[];
  get(id: string): MemoryEntry | undefined;
  put(e: MemoryEntry): void;
  /** False when there was none. */
  remove(id: string): boolean;
}

/** How memory works for one repository. */
export interface MemoryRepoSetting {
  /** Jobs of the repository learn entries and are offered them. */
  on: boolean;
  /** An entry a job learned waits for a person's approval before a job is offered it. */
  approval: boolean;
}

/** The settings record `repo-memory`, every field optional; read with defaults by `memorySettingsOf`. */
export interface MemorySettings extends MemoryRepoSetting {
  /** The most bytes of entries one job is told. */
  maxBytes: number;
  /** Days after its last change that an entry expires: no job is offered it until a person approves it again. */
  expireDays: number;
  /** Per repository (`owner/name`) or owner (`owner/*`): what differs from the fields above. */
  repos: Record<string, Partial<MemoryRepoSetting>>;
}

export const MEMORY_DEFAULTS: MemorySettings = { on: true, approval: true, maxBytes: 4096, expireDays: 180, repos: {} };

/** The longest entry text, and area. */
export const MEMORY_TEXT_MAX = 1000;
export const MEMORY_AREA_MAX = 200;
/** The most entries one repository keeps; a job learns no more past it. */
export const MEMORY_REPO_MAX = 200;
/** The most entries one job's final message adds or flags. */
export const MEMORY_LINES_MAX = 5;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NAME = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;
const AREA = /^[A-Za-z0-9_.@+\-/]+$/;

const isMap = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const isInt = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** Why `raw` cannot be the settings record, or undefined. */
export function memorySettingsProblem(raw: unknown): string | undefined {
  if (!isMap(raw)) return 'the repository memory settings are a map';
  const known = new Set(['on', 'approval', 'maxBytes', 'expireDays', 'repos']);
  const other = Object.keys(raw).find((k) => !known.has(k));
  if (other) return `${other} is no repository memory setting: on, approval, maxBytes, expireDays, repos`;
  for (const k of ['on', 'approval'] as const) if (raw[k] !== undefined && typeof raw[k] !== 'boolean') return `${k} is true or false`;
  if (raw.maxBytes !== undefined && !isInt(raw.maxBytes, 256, 16384)) return 'maxBytes is a whole number from 256 to 16384';
  if (raw.expireDays !== undefined && !isInt(raw.expireDays, 1, 3650)) return 'expireDays is a whole number from 1 to 3650';
  if (raw.repos === undefined) return undefined;
  if (!isMap(raw.repos)) return 'repos is a map of repository to its setting';
  if (Object.keys(raw.repos).length > 100) return 'at most 100 repositories have a setting';
  const seen = new Set<string>();
  for (const [name, s] of Object.entries(raw.repos)) {
    if (!NAME.test(name)) return `${name} is no repository: write owner/name or owner/*`;
    if (seen.has(name.toLowerCase())) return `${name} is named twice`;
    seen.add(name.toLowerCase());
    if (!isMap(s)) return `the setting of ${name} is a map`;
    const bad = Object.entries(s).find(([k, v]) => (k !== 'on' && k !== 'approval') || typeof v !== 'boolean');
    if (bad) return `the setting of ${name} holds only on and approval, each true or false`;
  }
  return undefined;
}

/** The settings with their defaults; a stored value that is not valid is read as none. */
export function memorySettingsOf(raw: unknown): MemorySettings {
  if (raw === undefined || memorySettingsProblem(raw) !== undefined) return { ...MEMORY_DEFAULTS, repos: {} };
  const r = raw as Partial<MemorySettings>;
  return { ...MEMORY_DEFAULTS, ...r, repos: { ...(r.repos ?? {}) } };
}

/** How memory works for `repo`: the user's setting, then its owner's (`owner/*`), then its own. */
export function memoryFor(s: MemorySettings, repo: string): MemoryRepoSetting {
  const wanted = repo.toLowerCase();
  const owner = `${wanted.split('/')[0]}/*`;
  const named = (key: string) => Object.entries(s.repos).find(([n]) => n.toLowerCase() === key)?.[1] ?? {};
  return { on: s.on, approval: s.approval, ...named(owner), ...named(wanted) };
}

/** `repo` as entries keep it, or undefined when it is no `owner/name`. */
export const memoryRepoOf = (repo: string | undefined): string | undefined => (repo && REPO.test(repo) ? repo.toLowerCase() : undefined);

/** Why an entry's fields cannot be kept, or undefined. */
export function memoryEntryProblem(e: { repo?: string; kind?: string; area?: string; text?: string }): string | undefined {
  if (e.repo !== undefined && !REPO.test(e.repo)) return `${e.repo} is no repository: write owner/name`;
  if (e.kind !== undefined && !(MEMORY_KINDS as readonly string[]).includes(e.kind)) return `${e.kind} is no kind of entry: convention or fix`;
  if (e.area !== undefined && (e.area.length > MEMORY_AREA_MAX || !AREA.test(e.area))) return `the area is a path of at most ${MEMORY_AREA_MAX} characters`;
  if (e.text !== undefined) {
    const text = e.text.trim();
    if (text === '') return 'the text is empty';
    if (text.length > MEMORY_TEXT_MAX) return `the text holds at most ${MEMORY_TEXT_MAX} characters`;
    if (/[\r\n]/.test(text)) return 'the text is one line';
  }
  return undefined;
}

/** True when `e` was last changed more than `expireDays` before `now`. */
export const memoryExpired = (e: Pick<MemoryEntry, 'updatedAt'>, s: Pick<MemorySettings, 'expireDays'>, now: Date): boolean =>
  now.getTime() - Date.parse(e.updatedAt) > s.expireDays * 86_400_000;

/** An entry's short id, as a job is told it and names it back. */
export const memoryShortId = (id: string): string => id.replaceAll('-', '').slice(0, 8);

/** A line of a job's final message: an entry it learned, or an entry it found wrong. */
export type MemoryLine =
  | { learned: { kind: MemoryKind; area?: string; text: string } }
  | { wrong: { id: string; reason: string } };

const LEARNED = /^HOPPER_MEMORY (convention|fix)(?: ([^\s:]+))?:\s*(.+)$/;
const WRONG = /^HOPPER_MEMORY_WRONG ([0-9a-f]{8}):\s*(.+)$/;
const bare = (line: string): string => line.trim().replace(/^[-*>\s`]+/, '').replace(/[`*\s]+$/, '');

/**
 * The lines of `text`, each memory line joined with the lines a terminal wrapped it into: the next lines up to a blank
 * line, a list item or another `HOPPER_` line.
 */
function unwrapped(text: string): string[] {
  const out: string[] = [];
  let open = false;
  for (const raw of text.split('\n')) {
    const line = bare(raw);
    const goesOn: boolean = open && line !== '' && !line.startsWith('HOPPER_') && !/^\s*(?:[-*>]|\d+\.)\s/.test(raw);
    if (goesOn) out[out.length - 1] += ` ${line}`;
    else out.push(line);
    open = goesOn || line.startsWith('HOPPER_MEMORY');
  }
  return out;
}

/** The memory lines of a job's final message, at most MEMORY_LINES_MAX; a line that breaks the entry rules is skipped. */
export function memoryLinesOf(text: string): MemoryLine[] {
  const lines: MemoryLine[] = [];
  for (const line of unwrapped(text)) {
    if (lines.length >= MEMORY_LINES_MAX) break;
    const w = WRONG.exec(line);
    if (w) { lines.push({ wrong: { id: w[1]!, reason: w[2]!.trim().slice(0, MEMORY_TEXT_MAX) } }); continue; }
    const l = LEARNED.exec(line);
    if (!l) continue;
    const learned = { kind: l[1] as MemoryKind, ...(l[2] ? { area: l[2].replace(/\/+$/, '') } : {}), text: l[3]!.trim() };
    if (memoryEntryProblem(learned) === undefined) lines.push({ learned });
  }
  return lines;
}

/**
 * `text` cut to `chars`, its memory lines kept: an executor cuts a job's final message to a summary, and the lines a
 * job writes at its end must not be cut off with it.
 */
export function withMemoryLines(text: string, chars: number): string {
  const cut = text.slice(0, chars);
  if (cut.length === text.length) return cut;
  const lost = unwrapped(text.slice(chars)).filter((l) => l.startsWith('HOPPER_MEMORY')).slice(0, MEMORY_LINES_MAX);
  return lost.length === 0 ? cut : `${cut}\n${lost.join('\n')}`;
}

/** The same entry: one repository, kind and area, and the same text but for case and spaces. */
export const sameMemory = (a: Pick<MemoryEntry, 'repo' | 'kind' | 'area' | 'text'>, b: Pick<MemoryEntry, 'repo' | 'kind' | 'area' | 'text'>): boolean =>
  a.repo === b.repo && a.kind === b.kind && (a.area ?? '') === (b.area ?? '') && norm(a.text) === norm(b.text);
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

const lineOf = (e: MemoryEntry): string => `- ${memoryShortId(e.id)} (${e.kind}${e.area ? `, ${e.area}` : ''}) ${e.text}`;

/**
 * The entries a job of `repo` is offered: approved and not expired, the most confident first, then the newest change;
 * as many as fit in `maxBytes`. `left`: the approved ones that did not fit.
 */
export function memoryOffer(entries: MemoryEntry[], s: MemorySettings, now: Date): { entries: MemoryEntry[]; left: number } {
  const usable = entries.filter((e) => e.state === 'approved' && !memoryExpired(e, s, now))
    .sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  const chosen: MemoryEntry[] = [];
  let bytes = 0;
  for (const e of usable) {
    const size = Buffer.byteLength(lineOf(e), 'utf8') + 1;
    if (bytes + size > s.maxBytes) continue;
    chosen.push(e);
    bytes += size;
  }
  return { entries: chosen, left: usable.length - chosen.length };
}

/** What a job of `repo` is told: the entries it is offered, then how it adds or flags one. */
export function memoryText(repo: string, offer: { entries: MemoryEntry[]; left: number }, approval: boolean): string {
  const head = offer.entries.length === 0
    ? `[hopper repository memory] The hopper keeps no memory entry of ${repo} for jobs yet.`
    : [
      `[hopper repository memory] What earlier jobs of ${repo} learned${approval ? ', each approved by a person' : ''}: one memory entry a line, its id first. Use the entries that fit the work; the code and the repository's own rules win over them.`,
      ...offer.entries.map(lineOf),
      ...(offer.left > 0 ? [`(${offer.left} more ${offer.left === 1 ? 'entry does' : 'entries do'} not fit.)`] : []),
    ].join('\n');
  return `${head}\nWhen this job found a convention of the repository (a build or test command, its layout, its style, a trap) or made a fix that a later job would otherwise have to find again, write it in your final message before the end marker, one line each: HOPPER_MEMORY convention: <text>, or HOPPER_MEMORY fix: <text>. For one part of the repository, put its path after the kind: HOPPER_MEMORY fix src/store: <text>. When an entry above is wrong now, write HOPPER_MEMORY_WRONG <its id>: <why>. At most ${MEMORY_LINES_MAX} lines; never a secret, a person's name or a machine detail.`;
}

/** An entry as the UI and the API show it: `expired` when no job is offered it for its age. */
export type MemoryEntryView = MemoryEntry & { shortId: string; expired: boolean };

/** GET /api/repo-memory: the entries, the settings with their defaults, and the settings record's `version`. */
export interface RepoMemoryView {
  entries: MemoryEntryView[];
  settings: MemorySettings;
  version: string;
}
