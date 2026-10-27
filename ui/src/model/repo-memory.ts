// Repository memory in the UI (issue #2847), pure: the repositories the entries are of, which acts an entry offers, what an
// entry's state says, the change an edit sends — only what differs —, and the settings a save sends, refused when a number
// or a repository name is not one the daemon takes.
import type { MemoryEntryView, MemoryKind, MemorySettings, MemoryState } from './wire.ts';

export const KIND_NAMES: Record<MemoryKind, string> = { convention: 'Convention', fix: 'Past fix' };
export const STATE_NAMES: Record<MemoryState, string> = { proposed: 'Waits for approval', approved: 'Approved', disabled: 'Disabled', flagged: 'Flagged as wrong' };

/** The repositories of the entries, in order. */
export const memoryRepos = (entries: readonly MemoryEntryView[]): string[] => [...new Set(entries.map((e) => e.repo))].sort();

export type MemoryAct = 'approve' | 'disable' | 'enable';

/** The acts an entry offers besides edit and remove: approve one no job is offered for its state or age, disable one in use. */
export function memoryActs(e: Pick<MemoryEntryView, 'state' | 'expired'>): MemoryAct[] {
  if (e.state === 'disabled') return ['enable'];
  const acts: MemoryAct[] = [];
  if (e.state === 'proposed' || e.state === 'flagged' || e.expired) acts.push('approve');
  acts.push('disable');
  return acts;
}

/** Whether the next job of its repository is offered the entry (when it fits the size cap). */
export const memoryOffered = (e: Pick<MemoryEntryView, 'state' | 'expired'>): boolean => e.state === 'approved' && !e.expired;

export interface MemoryEntryDraft { kind: MemoryKind; area: string; text: string }

/** The fields an edit sends: only what differs (undefined: nothing), an emptied area as null; or why it is refused. */
export function memoryEditPatch(e: MemoryEntryView, d: MemoryEntryDraft): { ok: true; patch: { kind?: MemoryKind; area?: string | null; text?: string } | undefined } | { ok: false; error: string } {
  const text = d.text.trim(), area = d.area.trim();
  if (text === '') return { ok: false, error: 'The text is empty' };
  if (/[\r\n]/.test(text)) return { ok: false, error: 'The text is one line' };
  const patch: { kind?: MemoryKind; area?: string | null; text?: string } = {};
  if (d.kind !== e.kind) patch.kind = d.kind;
  if (area !== (e.area ?? '')) patch.area = area === '' ? null : area;
  if (text !== e.text) patch.text = text;
  return { ok: true, patch: Object.keys(patch).length ? patch : undefined };
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REPO_OR_OWNER = /^[A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+|\*)$/;

/** A repository a person adds an entry to: `owner/name`. */
export const isMemoryRepo = (repo: string): boolean => REPO.test(repo.trim());

export interface MemoryRepoRow { repo: string; on: boolean; approval: boolean }
export interface MemorySettingsDraft { on: boolean; approval: boolean; maxBytes: string; expireDays: string; repos: MemoryRepoRow[] }

export const memorySettingsDraft = (s: MemorySettings): MemorySettingsDraft => ({
  on: s.on, approval: s.approval, maxBytes: String(s.maxBytes), expireDays: String(s.expireDays),
  repos: Object.entries(s.repos).map(([repo, r]) => ({ repo, on: r.on ?? s.on, approval: r.approval ?? s.approval })),
});

const whole = (raw: string, min: number, max: number): number | undefined => {
  const n = Number(raw.trim());
  return raw.trim() !== '' && Number.isInteger(n) && n >= min && n <= max ? n : undefined;
};

/** The settings a save sends, or why the draft is refused. */
export function memorySettingsOfDraft(d: MemorySettingsDraft): { ok: true; settings: MemorySettings } | { ok: false; error: string } {
  const maxBytes = whole(d.maxBytes, 256, 16384);
  if (maxBytes === undefined) return { ok: false, error: 'Size cap: a whole number of bytes from 256 to 16384' };
  const expireDays = whole(d.expireDays, 1, 3650);
  if (expireDays === undefined) return { ok: false, error: 'Expiry: a whole number of days from 1 to 3650' };
  const repos: MemorySettings['repos'] = {};
  for (const r of d.repos) {
    const name = r.repo.trim();
    if (!REPO_OR_OWNER.test(name)) return { ok: false, error: 'Write each repository as owner/name, or owner/* for all of that owner\'s' };
    if (Object.keys(repos).some((k) => k.toLowerCase() === name.toLowerCase())) return { ok: false, error: `${name} is named twice` };
    repos[name] = { on: r.on, approval: r.approval };
  }
  return { ok: true, settings: { on: d.on, approval: d.approval, maxBytes, expireDays, repos } };
}

/** What is on now, in one sentence. */
export function memorySummary(s: MemorySettings): string {
  const other = Object.keys(s.repos).length;
  const rest = other ? `; ${other} ${other === 1 ? 'repository has' : 'repositories have'} a setting of its own` : '';
  if (!s.on) return `Off: jobs learn no entry and are offered none${rest}.`;
  return `On: ${s.approval ? 'an entry a job learned waits for a person\'s approval' : 'an entry a job learned is offered at once'}; each job is offered at most ${s.maxBytes} bytes; an entry expires ${s.expireDays} days after its last change${rest}.`;
}
