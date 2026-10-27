// Repository memory (issue #2847, design.md "Repository memory"): one user's memory entries learned from a finished job's
// memory lines, offered to each job of the same repository as it starts and recorded on the job (`job.memory_offered`),
// and a person's acts on them — add, edit, approve, disable, enable, remove — and on the settings record `repo-memory`.
// No I/O but the user's store.
import { maskGitHubTokens } from '../secrets/mask.ts';
import {
  MEMORY_REPO_MAX, REPO_MEMORY, memoryEntryProblem, memoryExpired, memoryFor, memoryLinesOf, memoryOffer, memoryRepoOf,
  memoryShortId, memorySettingsOf, memorySettingsProblem, memoryText, sameMemory,
  type MemoryEntry, type MemoryKind, type MemorySettings, type RepoMemoryView,
} from '../domain/repo-memory.ts';
import type { UserStore } from '../domain/store.ts';
import type { Job } from '../domain/types.ts';

type Store = Pick<UserStore, 'memoryEntries' | 'events' | 'config' | 'tx'>;

/** The settings as stored, with their defaults. */
export const readMemorySettings = (store: Pick<UserStore, 'config'>): MemorySettings => memorySettingsOf(store.config.read(REPO_MEMORY));

const summaryOf = (result: unknown): string | undefined => {
  if (typeof result === 'string') return result;
  const s = typeof result === 'object' && result !== null ? (result as { summary?: unknown }).summary : undefined;
  return typeof s === 'string' ? s : undefined;
};

/**
 * What finished job `job` learned: the memory lines of its final message (`result`, or its `summary`). A new entry waits
 * for a person's approval when the repository's setting asks it, else it is approved; one the repository has already
 * is learned again — more confident, its age renewed — unless a person disabled it. A wrong line flags an approved or
 * proposed entry of the same repository. Nothing for a job of no repository, or of one with memory off.
 */
export function learnFromJob(store: Store, job: Pick<Job, 'id' | 'source'>, result: unknown, at: string, newId: () => string): void {
  const repo = memoryRepoOf(job.source?.repo);
  const text = summaryOf(result);
  if (!repo || text === undefined) return;
  const setting = memoryFor(readMemorySettings(store), repo);
  if (!setting.on) return;
  const lines = memoryLinesOf(maskGitHubTokens(text));
  if (lines.length === 0) return;
  store.tx(() => {
    const kept = store.memoryEntries.list(repo);
    for (const line of lines) {
      if ('wrong' in line) {
        const e = kept.find((k) => memoryShortId(k.id) === line.wrong.id && (k.state === 'approved' || k.state === 'proposed'));
        if (!e) continue;
        const flagged: MemoryEntry = { ...e, state: 'flagged', flag: { jobId: job.id, reason: line.wrong.reason, at }, by: `job ${job.id}` };
        store.memoryEntries.put(flagged);
        Object.assign(e, flagged);
        store.events.append({ type: 'repo_memory.flagged', jobId: job.id, data: { entry: e.id, repo, reason: line.wrong.reason } });
        continue;
      }
      const candidate = { repo, ...line.learned };
      const same = kept.find((k) => sameMemory(k, candidate));
      if (same) {
        if (same.state === 'disabled' || same.state === 'flagged') continue;
        const confidence = same.confidence >= 0.9 ? same.confidence : Math.min(0.9, Math.round((same.confidence + 0.1) * 10) / 10);
        const again: MemoryEntry = { ...same, confidence, updatedAt: at };
        store.memoryEntries.put(again);
        Object.assign(same, again);
        store.events.append({ type: 'repo_memory.learned', jobId: job.id, data: learnedData(again, true) });
        continue;
      }
      if (kept.length >= MEMORY_REPO_MAX) continue;
      const e: MemoryEntry = {
        id: newId(), ...candidate, state: setting.approval ? 'proposed' : 'approved', confidence: 0.5, sourceJobId: job.id,
        createdAt: at, updatedAt: at, by: `job ${job.id}`,
      };
      store.memoryEntries.put(e);
      kept.push(e);
      store.events.append({ type: 'repo_memory.learned', jobId: job.id, data: learnedData(e, false) });
    }
  });
}

const learnedData = (e: MemoryEntry, again: boolean) =>
  ({ entry: e.id, repo: e.repo, kind: e.kind, ...(e.area ? { area: e.area } : {}), text: e.text, state: e.state, confidence: e.confidence, again });

/**
 * What job `job` is told of its repository's memory as it starts, '' for a job of no repository or one with memory off.
 * The entries it is offered are recorded on its timeline as `job.memory_offered`, again only when they changed since its
 * last start.
 */
export function offerMemory(store: Store, job: Pick<Job, 'id' | 'source'>, now: Date): string {
  const repo = memoryRepoOf(job.source?.repo);
  if (!repo) return '';
  const settings = readMemorySettings(store);
  const setting = memoryFor(settings, repo);
  if (!setting.on) return '';
  const offer = memoryOffer(store.memoryEntries.list(repo), settings, now);
  const ids = offer.entries.map((e) => e.id);
  const last = store.events.recent(1, ['job.memory_offered'], job.id)[0]?.data as { entries?: string[]; left?: number } | undefined;
  if (last === undefined ? ids.length > 0 : (last.entries ?? []).join() !== ids.join() || (last.left ?? 0) !== offer.left) {
    store.events.append({ type: 'job.memory_offered', jobId: job.id, data: { repo, entries: ids, left: offer.left } });
  }
  return memoryText(job.source!.repo!, offer, setting.approval);
}

/** GET /api/repo-memory: the entries of `repo` (else of every repository), newest change first, and the settings. */
export function memoryView(store: Pick<UserStore, 'memoryEntries' | 'config'>, repo: string | undefined, now: Date): RepoMemoryView {
  const settings = readMemorySettings(store);
  const entries = store.memoryEntries.list(repo?.toLowerCase())
    .map((e) => ({ ...e, shortId: memoryShortId(e.id), expired: memoryExpired(e, settings, now) }));
  return { entries, settings, version: store.config.version(REPO_MEMORY) };
}

/** A person's act on the entries. */
export type MemoryAct =
  | { action: 'add'; repo: string; kind: MemoryKind; area?: string; text: string }
  | { action: 'edit'; id: string; kind?: MemoryKind; area?: string | null; text?: string }
  | { action: 'approve' | 'disable' | 'enable' | 'remove'; id: string };

export type MemoryActResult = { entry: MemoryEntry } | { removed: true } | { status: 400 | 404 | 409; no: string };

/** An entry found by its id or its short id. */
const entryOf = (store: Store, id: string): MemoryEntry | undefined =>
  store.memoryEntries.get(id) ?? (/^[0-9a-f]{8}$/.test(id) ? store.memoryEntries.list().filter((e) => memoryShortId(e.id) === id) : []).at(0);

/**
 * Do `act` as `by`, recorded as `repo_memory.changed`. A person's entry is approved at once, with confidence 1. An edit,
 * an approval or an enable renews its age; an approval or an edit clears a flag. The next job of the repository gets it.
 */
export function actOnMemory(store: Store, act: MemoryAct, by: string, at: string, newId: () => string): MemoryActResult {
  return store.tx((): MemoryActResult => {
    const changed = (e: MemoryEntry, change: string): MemoryActResult => {
      store.events.append({ type: 'repo_memory.changed', data: { entry: e.id, repo: e.repo, change, by } });
      return change === 'removed' ? { removed: true } : { entry: e };
    };
    if (act.action === 'add') {
      const area = act.area?.replace(/\/+$/, '') || undefined;
      const problem = memoryEntryProblem({ repo: act.repo, kind: act.kind, ...(area ? { area } : {}), text: act.text });
      if (problem) return { status: 400, no: problem };
      const repo = act.repo.toLowerCase();
      const kept = store.memoryEntries.list(repo);
      const candidate = { repo, kind: act.kind, ...(area ? { area } : {}), text: act.text.trim() };
      if (kept.some((k) => sameMemory(k, candidate))) return { status: 409, no: `${repo} has this entry already` };
      if (kept.length >= MEMORY_REPO_MAX) return { status: 409, no: `${repo} keeps at most ${MEMORY_REPO_MAX} entries: remove one first` };
      const e: MemoryEntry = { id: newId(), ...candidate, state: 'approved', confidence: 1, createdAt: at, updatedAt: at, by };
      store.memoryEntries.put(e);
      return changed(e, 'added');
    }
    const e = entryOf(store, act.id);
    if (!e) return { status: 404, no: `no memory entry ${act.id}` };
    if (act.action === 'remove') {
      store.memoryEntries.remove(e.id);
      return changed(e, 'removed');
    }
    if (act.action === 'edit') {
      const area = act.area === null ? undefined : act.area === undefined ? e.area : act.area.replace(/\/+$/, '') || undefined;
      const next = { kind: act.kind ?? e.kind, ...(area ? { area } : {}), text: act.text?.trim() ?? e.text };
      const problem = memoryEntryProblem(next);
      if (problem) return { status: 400, no: problem };
      const { area: _area, flag: _flag, ...rest } = e;
      const edited: MemoryEntry = { ...rest, ...next, state: e.state === 'flagged' ? 'approved' : e.state, updatedAt: at, by };
      store.memoryEntries.put(edited);
      return changed(edited, 'edited');
    }
    if (act.action === 'disable') {
      if (e.state === 'disabled') return { status: 409, no: `memory entry ${memoryShortId(e.id)} is disabled already` };
      const next: MemoryEntry = { ...e, state: 'disabled', by };
      store.memoryEntries.put(next);
      return changed(next, 'disabled');
    }
    if (act.action === 'enable' && e.state !== 'disabled') return { status: 409, no: `memory entry ${memoryShortId(e.id)} is not disabled` };
    const { flag: _flag, ...rest } = e;
    const next: MemoryEntry = { ...rest, state: 'approved', updatedAt: at, by };
    store.memoryEntries.put(next);
    return changed(next, act.action === 'enable' ? 'enabled' : 'approved');
  });
}

export type MemorySettingsEdit = { ok: true; settings: MemorySettings; version: string } | { ok: false; code: 'invalid' | 'conflict'; error: string };

/** Replace the settings record with `settings` if it is still at `version`. */
export function writeMemorySettings(store: Pick<UserStore, 'config'>, settings: unknown, version: string): MemorySettingsEdit {
  const problem = memorySettingsProblem(settings);
  if (problem) return { ok: false, code: 'invalid', error: problem };
  if (!store.config.write(REPO_MEMORY, settings, version)) return { ok: false, code: 'conflict', error: 'the repository memory settings changed since they were read; reload and edit again' };
  return { ok: true, settings: readMemorySettings(store), version: store.config.version(REPO_MEMORY) };
}
