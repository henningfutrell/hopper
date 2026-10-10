// A skill request a job waits on (issue #613, design.md "The job stream"): `hopper-skill --wait` asks once; when a person
// must give something first (202), the hopper opens a watch on the request and tells the job on its job stream when the
// answer is ready. The answer is the broker's, asked again under the request's id when what it waits on may have
// changed — a vault change, or the job subscribing again (after a restart that dropped the credential request, which
// asking again opens again) — never on a timer.
import type { DomainEvent, EventType } from '../domain/types.ts';
import type { SkillAnswer, SkillBroker } from './broker.ts';

/** The stream types the skill broker emits, each with its phase. */
export const SKILL_STREAM_TYPES = {
  /** A person is asked; the payload is the broker's `waiting:` text. */
  'skill.waiting': 'waiting',
  /** The skill, loaded; the payload is the text the job reads. */
  'skill.loaded': 'done',
  /** A no; the payload is its `no:` text. */
  'skill.refused': 'failed',
} as const;

/** The vault's events after which a waiting request may be answered otherwise. Never `vault.credential_asked`: asking again makes one. */
const VAULT_CHANGES: readonly EventType[] = ['vault.credential_given', 'vault.credential_declined', 'vault.approved', 'vault.secret_set', 'vault.secret_removed'];
/** The fields of a request that are asked again; `wait` and `timeout` are the watch's. */
const ASKED = ['name', 'asset', 'why', 'credential'];

/** One user's side: their job stream, and their event log to hear the vault's changes on. */
export interface WaitUser {
  stream: {
    open(o: { id: string; jobId: string; seconds?: number; body: Record<string, string> }): { id: string; deadline: string };
    emit(jobId: string, type: string, payload: unknown, request?: string): unknown;
    finish(jobId: string, request: string, type: string, payload: unknown): unknown;
    repo: { openWatches(jobId?: string): { id: string; jobId: string; body: Record<string, string> }[] };
  };
  subscribe(l: (e: DomainEvent) => void): () => void;
}

export interface SkillWaits {
  /** POST /job/skill: the broker's answer; a 202 asked with `wait` opens a watch, and the answer says which. */
  handle(authorization: string | undefined, body: unknown): Promise<SkillAnswer>;
  /** Asks again each watch open on the user's job (every job of theirs when none is named): an answer ends it. */
  redrive(userId: string, jobId?: string): Promise<void>;
}

const fieldsOf = (body: unknown): Record<string, string> => {
  const b = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  return Object.fromEntries(ASKED.flatMap((k) => (typeof b[k] === 'string' && b[k] !== '' ? [[k, b[k]]] : [])));
};
const said = (body: unknown, key: string): string | undefined => {
  const v = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

export function createSkillWaits(o: { broker: SkillBroker; user(id: string): WaitUser | undefined; log(line: string): void }): SkillWaits {
  /** The users whose vault changes are heard, by their event log's subscribe: one listener each. */
  const heard = new WeakSet<WaitUser['subscribe']>();
  /** The watches being asked again now: one at a time each. */
  const busy = new Set<string>();
  /** The busy watches a change was heard for meanwhile. */
  const again = new Set<string>();

  const hear = (userId: string, u: WaitUser): void => {
    if (heard.has(u.subscribe)) return;
    heard.add(u.subscribe);
    u.subscribe((e) => {
      if (VAULT_CHANGES.includes(e.type)) void waits.redrive(userId);
    });
  };

  const waits: SkillWaits = {
    async handle(authorization, body) {
      const a = await o.broker.handle(authorization, body);
      if (a.status !== 202 || said(body, 'wait') === undefined || !a.asker) return a;
      const u = o.user(a.asker.userId);
      if (!u) return a;
      const { userId, jobId, requestId } = a.asker;
      const timeout = Number(said(body, 'timeout'));
      const w = u.stream.open({ id: requestId, jobId, body: fieldsOf(body), ...(Number.isFinite(timeout) && timeout > 0 ? { seconds: timeout } : {}) });
      u.stream.emit(jobId, 'skill.waiting', a.text, requestId);
      hear(userId, u);
      const seconds = Math.round((Date.parse(w.deadline) - Date.now()) / 1000);
      return { ...a, text: `${a.text}wait: ${w.id} until ${w.deadline} (${seconds} s): the hopper tells the job on its stream, GET /job/stream?request=${w.id}.\n` };
    },

    async redrive(userId, jobId) {
      const u = o.user(userId);
      if (!u) return;
      hear(userId, u);
      for (const w of u.stream.repo.openWatches(jobId)) {
        // A change heard while the watch is asked again: asked once more after, so no change is missed.
        if (busy.has(w.id)) { again.add(w.id); continue; }
        busy.add(w.id);
        try {
          do {
            again.delete(w.id);
            const a = await o.broker.again(userId, w.jobId, w.id, w.body);
            if (a !== undefined && a.status !== 202) {
              u.stream.finish(w.jobId, w.id, a.status === 200 ? 'skill.loaded' : 'skill.refused', a.text);
              break;
            }
          } while (again.has(w.id));
        } catch (e) {
          o.log(`hopper: skills: asking request ${w.id} again failed: ${(e as Error).message}`);
        } finally {
          busy.delete(w.id);
          again.delete(w.id);
        }
      }
    },
  };
  return waits;
}
