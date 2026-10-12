// Artifacts (issue #624, design.md "Artifacts"): a file a job makes for a person to see — a chart, an HTML page, a
// report, an image, a CSV. The hopper keeps it in the user's database, serves it at a stable URL, and lets its owner
// share it with another user of the hopper or by an expiring public link. Kinds, limits and the repository port. Pure.

/** How the hopper shows an artifact: from its media type. `file` is anything else: a download only. */
export const ARTIFACT_KINDS = ['html', 'svg', 'image', 'pdf', 'csv', 'markdown', 'json', 'text', 'file'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** The media types the hopper knows, each with its kind; any other is served as `application/octet-stream`. */
export const ARTIFACT_TYPES: Readonly<Record<string, ArtifactKind>> = {
  'text/html': 'html',
  'image/svg+xml': 'svg',
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/gif': 'image',
  'image/webp': 'image',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'text/markdown': 'markdown',
  'application/json': 'json',
  'text/plain': 'text',
  'application/octet-stream': 'file',
};

/** File name extensions, each with its media type: what `put` takes when no type is given. */
export const ARTIFACT_EXTENSIONS: Readonly<Record<string, string>> = {
  html: 'text/html', htm: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', csv: 'text/csv', md: 'text/markdown', markdown: 'text/markdown',
  json: 'application/json', txt: 'text/plain', log: 'text/plain',
};

/** The kinds whose content is text: the hopper masks secrets in them before it keeps them (issue #597). */
export const TEXT_KINDS: readonly ArtifactKind[] = ['html', 'svg', 'csv', 'markdown', 'json', 'text'];

/** The short names `put --type` takes, beside a media type. */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  html: 'text/html', svg: 'image/svg+xml', png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', csv: 'text/csv', markdown: 'text/markdown', md: 'text/markdown', json: 'application/json', text: 'text/plain', txt: 'text/plain', file: 'application/octet-stream',
};

/** The media type for a `--type` (a short name or a media type) and a file name; undefined: a type the hopper does not know. */
export function artifactType(name: string, type?: string): string | undefined {
  if (type !== undefined) {
    const t = type.trim().toLowerCase().split(';')[0]!.trim();
    return TYPE_NAMES[t] ?? (t in ARTIFACT_TYPES ? t : undefined);
  }
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  return (ext && ARTIFACT_EXTENSIONS[ext]) ?? 'application/octet-stream';
}

export const kindOf = (type: string): ArtifactKind => ARTIFACT_TYPES[type] ?? 'file';

/** An element that draws: what makes an HTML artifact a visual (issue #675). */
const DRAWING = /<(svg|canvas|img)[\s>/]/i;
/** A script: a page that draws at run time (issue #675). */
const SCRIPT = /<script[\s>]/i;

/**
 * Issue #675: an artifact shows the result — a diagram, a chart, an interactive view. An HTML artifact with no `<svg>`,
 * `<canvas>`, `<img>` or `<script>` is styled text: the hopper keeps it, and the job hears this warning. Undefined: no warning.
 */
export function visualWarning(kind: ArtifactKind, content: Buffer): string | undefined {
  // A page that runs a script draws at run time (issue #675): a bundled library's diagram, a chart, an interactive view.
  if (kind !== 'html' || DRAWING.test(content.toString('utf8')) || SCRIPT.test(content.toString('utf8'))) return undefined;
  return 'the artifact has no visual: it has no <svg>, <canvas>, <img> or <script>. Show the result: a diagram, a chart, an interactive view; put prose in the issue comment or the job result';
}

/** A put with no summary (issue #675): kept, but lists, the job card and share previews have only its title. */
export const NO_SUMMARY_WARNING = 'the artifact has no summary: give --summary with one line that says what it shows';

/** An artifact's summary as kept: one line, at most ARTIFACT_SUMMARY_MAX characters; undefined: none. */
export function artifactSummary(text: string | undefined): string | undefined {
  const line = (text ?? '').replace(/\s+/g, ' ').trim().slice(0, ARTIFACT_SUMMARY_MAX);
  return line === '' ? undefined : line;
}

/** A file name the hopper keeps: the base name, no path, no control character, at most 200 characters. */
export function artifactName(name: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is removed
  const base = (name.split(/[\\/]/).at(-1) ?? '').replace(/[\x00-\x1f\x7f"]/g, '').trim().slice(0, 200);
  return base === '' || base === '.' || base === '..' ? 'artifact' : base;
}

/** A title's prefix: the text before its first colon, else all of it; lower case, spaces made one. */
const titlePrefix = (title: string): string => (title.split(':')[0] ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
/** The issue references a title names: `#662`. */
const issueRefs = (title: string): string[] => title.match(/#\d+\b/g) ?? [];

/**
 * Issue #687: the artifact of the user's that a new put looks like a revision of — the same file name, the same title
 * prefix, or an issue reference both titles name —, newest first; undefined: none. Pure.
 */
export function lookAlike(put: { name: string; title: string }, artifacts: readonly Artifact[]): Artifact | undefined {
  const prefix = titlePrefix(put.title);
  const refs = issueRefs(put.title);
  return artifacts.find((a) => a.name === put.name || (prefix !== '' && titlePrefix(a.title) === prefix) || issueRefs(a.title).some((r) => refs.includes(r)));
}

/** What a put that looks like a revision of `a` is told (issue #687). */
export const lookAlikeWarning = (a: Pick<Artifact, 'id' | 'title'>): string =>
  `looks like a revision of ${a.id} '${a.title}': pass --to ${a.id}, or --new to keep it separate`;

export const ARTIFACT_TITLE_MAX = 200;
export const ARTIFACT_SUMMARY_MAX = 300;
export const ARTIFACT_NOTE_MAX = 300;

/** One artifact, as the database keeps it, without its content. */
export interface Artifact {
  id: string;
  /** The user whose job made it: its owner. */
  userId: string;
  jobId: string;
  /** The issue the job came from, when it came from one: its URL and `owner/repo#N`. */
  issue?: { url: string; ref: string };
  title: string;
  /** The file name it was put as. */
  name: string;
  /** Its media type. */
  type: string;
  kind: ArtifactKind;
  /** In bytes. */
  size: number;
  /** The SHA-256 of its content, hex. */
  sha256: string;
  createdAt: string;
  /** One line that says what it shows (issue #675): in lists, on the job card and in share previews. */
  summary?: string;
  /** Its latest revision's number (issue #675): 1 when it was put, one more at each change. */
  revision: number;
  /** When its latest revision was made, and who made it: a job (`job <id>`) or a person (`github:octocat`). */
  updatedAt: string;
  revisedBy: string;
  /** The latest revision's one-line note: what changed. */
  note?: string;
  /** Whether its latest revision is pinned: the retention sweep keeps a pinned revision, and its artifact. */
  pinned: boolean;
}

/**
 * One revision of an artifact (issue #675): every change is one, numbered from 1. The latest is the artifact itself;
 * older ones stay readable until the retention sweep, unless pinned.
 */
export interface ArtifactRevision {
  artifactId: string;
  n: number;
  title: string;
  summary?: string;
  name: string;
  type: string;
  kind: ArtifactKind;
  size: number;
  sha256: string;
  createdAt: string;
  /** A job (`job <id>`) or a person. */
  by: string;
  note?: string;
  pinned: boolean;
  /** Whether it is the artifact's latest revision. */
  latest: boolean;
}

/** Who a share lets see an artifact: another user of the hopper, or anybody with the link. */
export const SHARE_KINDS = ['user', 'link'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];

/** A share of an artifact: live until it is revoked, or, for a link, until it expires. */
export interface ArtifactShare {
  id: string;
  artifactId: string;
  kind: ShareKind;
  /** The user it is shared with (kind `user`): their id and name. */
  userId?: string;
  userName?: string;
  /** When a link stops working. */
  expiresAt?: string;
  createdAt: string;
  /** A person (`github:octocat`) or a job (`job <id>`). */
  createdBy: string;
  revokedAt?: string;
  revokedBy?: string;
}

/** A link's share as it is kept: its token is only hashed. */
export interface NewArtifactShare extends Omit<ArtifactShare, 'revokedAt' | 'revokedBy'> { tokenHash?: string }

/** Whether a share lets anybody in now. */
export const shareLive = (s: Pick<ArtifactShare, 'revokedAt' | 'expiresAt'>, now: string): boolean =>
  s.revokedAt === undefined && (s.expiresAt === undefined || s.expiresAt > now);

/** The limits and retention of a user's artifacts, edited in Settings → Artifacts. */
export interface ArtifactSettings {
  /** The most one artifact may hold, in bytes. */
  maxBytes: number;
  /** The most all of a user's artifacts may hold together, in bytes. */
  userBytes: number;
  /** An artifact older than this many days is removed. */
  retentionDays: number;
  /** Whether a public link works: off, every public link stops at once and no new one is made. */
  publicLinks: boolean;
  /** How long a public link works when its maker says nothing, and the most it may, in hours. */
  linkHours: number;
  linkHoursMax: number;
  /**
   * Where a link a job reports points (issue #673): an origin the hopper answers to (`http://192.0.2.10:4790`), or
   * empty — the public URL, else an IP or `.local` LAN name.
   */
  linkBase: string;
}

const MB = 1024 * 1024;
export const DEFAULT_ARTIFACT_SETTINGS: ArtifactSettings = {
  maxBytes: 10 * MB, userBytes: 500 * MB, retentionDays: 30, publicLinks: true, linkHours: 24, linkHoursMax: 24 * 7, linkBase: '',
};
/** The most any setting may allow: what the HTTP edge reads into memory at once is bounded by it. */
export const ARTIFACT_MAX_BYTES = 100 * MB;
export const ARTIFACT_LIMITS = { maxBytes: ARTIFACT_MAX_BYTES, userBytes: 100 * 1024 * MB, retentionDays: 3650, linkHours: 24 * 365 } as const;

/** A revision as GET /api/artifacts/:id/revisions answers it: where this viewer loads its content. */
export interface ArtifactRevisionView extends ArtifactRevision { contentUrl: string }

/** One artifact as GET /api/artifacts answers it: where to open it, and, for its owner, its shares. */
export interface ArtifactView extends Artifact {
  /** The stable URL: the UI's Artifacts view, which opens it for whoever may see it. */
  url: string;
  /** Where its content is served now, for this viewer: a signed URL that works for a short time. */
  contentUrl: string;
  /** The owner's name, for an artifact shared with the viewer. */
  owner?: string;
  shares?: ArtifactShare[];
}

export interface ArtifactsView {
  artifacts: ArtifactView[];
  /** Shared with the viewer by other users. */
  shared: ArtifactView[];
  /** How many bytes the user's artifacts hold. */
  usedBytes: number;
  settings: ArtifactSettings;
}

export interface ArtifactRepository {
  add(a: Artifact, content: Buffer): void;
  get(id: string): Artifact | undefined;
  content(id: string): Buffer | undefined;
  /** Newest first; a job's alone when one is named. */
  list(o?: { jobId?: string; limit?: number }): Artifact[];
  /** A new latest revision (issue #675): the latest so far is kept as an older revision, in the same transaction. */
  revise(a: Artifact, content: Buffer): void;
  /** Every revision, newest first: the latest is the artifact. */
  revisions(id: string): ArtifactRevision[];
  revision(id: string, n: number): ArtifactRevision | undefined;
  revisionContent(id: string, n: number): Buffer | undefined;
  /** Pins or unpins revision `n`; false: no such revision. */
  pinRevision(id: string, n: number, pinned: boolean): boolean;
  /** The older revisions, not pinned, made before `iso`: what the sweep removes. */
  oldRevisions(iso: string): { artifactId: string; n: number }[];
  removeRevision(id: string, n: number): boolean;
  /** Removes it and its shares; false: no such artifact. */
  remove(id: string): boolean;
  usedBytes(): number;
  /** The ids of the artifacts last changed before `iso` that hold no pinned revision. */
  olderThan(iso: string): string[];
  addShare(s: NewArtifactShare): void;
  share(id: string): ArtifactShare | undefined;
  /** The share whose link token hashes to `hash`. */
  shareByHash(hash: string): ArtifactShare | undefined;
  /** An artifact's shares, newest first; `live` at `now` only, when given. */
  shares(artifactId: string, now?: string): ArtifactShare[];
  /** Every live share at `now`, of every artifact. */
  liveShares(now: string): ArtifactShare[];
  revokeShare(id: string, by: string, at: string): boolean;
  settings(): ArtifactSettings;
  setSettings(s: ArtifactSettings): void;
}
