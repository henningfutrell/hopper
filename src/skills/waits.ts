// A skill request a job waits on (issue #613, design.md "The job stream"): `hopper-skill --wait` asks once; when a person
// must give something first (202), the hopper opens a watch on the request and tells the job on its job stream when the
// answer is ready. The answer is the broker's, asked again under the request's id when what it waits on may have
// changed — a vault change, or the job subscribing again (after a restart that dropped the credential request, which
// asking again opens again) — never on a timer.
// Issue #998: a 202 opens a watch with --wait or not, one per job and request: a job that asked without --wait, then
// ended its turn with HOPPER_WAITING, would have nothing to wake it. When a watch ends with an answer and its job is on
// its own wait, the hopper ends that wait with the answer, so the job goes on.
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
const VAULT_CHANGES: readonly EventType[] = [
  'vault.credential_given', 'vault.credential_declined', 'vault.approved', 'vault.secret_set', 'vault.secret_removed', 'template.profile_approved', 'template.checked',
  // A sandbox request (issue #991): approved, declined, its box started or not.
  'vault.sandbox_approved', 'vault.sandbox_declined', 'vault.sandbox_started', 'vault.sandbox_failed',
  // An action grant (issue #2206, part 2): a template request's action check waits for it.
  'vault.action_granted', 'vault.action_declined',
];
/**
 * The fields of a request that are asked again; `wait` and `timeout` are the watch's. Issue #1966: a template request's
 * vault secrets, egress hosts and image too, or a request with them and no need is asked again with no need, and refused. Issue #2206:
 * its AWS actions, so the action check is asked again.
 */
const ASKED = ['name', 'asset', 'why', 'plan', 'credential', 'needs', 'template', 'secrets', 'egress', 'image', 'tools', 'actions', 'targets', 'database'];

/** One user's side: their job stream, and their event log to hear the vault's changes on. */
export interface WaitUser {
  stream: {
    open(o: { id: string; jobId: string; seconds?: number; body: Record<string, string> }): { id: string; deadline: string };
    emit(jobId: string, type: string, payload: unknown, request?: string): unknown;
    finish(jobId: string, request: string, type: string, payload: unknown): unknown;
    repo: { openWatches(jobId?: string): { id: string; jobId: string; body: Record<string, string> }[] };
  };
  /** Their event log: the same object for as long as the user's runtime runs, so it is heard once (issue #1383). */
  events: { subscribe(l: (e: DomainEvent) => void): () => void };
  /** Ends the job's own wait with the answer, when it is on one (issue #998); nothing otherwise. */
  endWait?(jobId: string, answer: string): void;
}

export interface SkillWaits {
  /** POST /job/skill: the broker's answer; a 202 opens a watch (with `wait`, a new one), and the answer says which. */
  handle(authorization: string | undefined, body: unknown): Promise<SkillAnswer>;
  /** Asks again each watch open on the user's job (every job of theirs when none is named): an answer ends it. */
  redrive(userId: string, jobId?: string): Promise<void>;
}

const fieldsOf = (body: unknown): Record<string, string> => {
  const b = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {};
  return Object.fromEntries(ASKED.flatMap((k) => (typeof b[k] === 'string' && b[k] !== '' ? [[k, b[k]]] : [])));
};
const sameFields = (a: Record<string, string>, b: Record<string, string>): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([k, v]) => b[k] === v);
const said = (body: unknown, key: string): string | undefined => {
  const v = typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
};

export function createSkillWaits(o: { broker: SkillBroker; user(id: string): WaitUser | undefined; log(line: string): void }): SkillWaits {
  /**
   * The event logs heard: one listener each. Keyed by the log, not by what `user()` answers, which is a new object each
   * call: keyed so, each redrive added a listener that redrives, and the listeners doubled at each change (issue #1383).
   */
  const heard = new WeakSet<object>();
  /** The watches being asked again now: one at a time each. */
  const busy = new Set<string>();
  /** The busy watches a change was heard for meanwhile. */
  const again = new Set<string>();

  const hear = (userId: string, u: WaitUser): void => {
    if (heard.has(u.events)) return;
    heard.add(u.events);
    u.events.subscribe((e) => {
      if (VAULT_CHANGES.includes(e.type)) void waits.redrive(userId);
    });
  };

  const waits: SkillWaits = {
    async handle(authorization, body) {
      const a = await o.broker.handle(authorization, body);
      if (a.status !== 202 || !a.asker) return a;
      const u = o.user(a.asker.userId);
      if (!u) return a;
      const { userId, jobId, requestId } = a.asker;
      if (said(body, 'wait') === undefined) {
        // No --wait: the watch is only to end the job's own wait, so the same request asked again keeps the one it has.
        const fields = fieldsOf(body);
        const had = u.stream.repo.openWatches(jobId).find((w) => sameFields(w.body, fields));
        const w = had ?? u.stream.open({ id: requestId, jobId, body: fields });
        if (!had) u.stream.emit(jobId, 'skill.waiting', a.text, requestId);
        hear(userId, u);
        return { ...a, text: `${a.text}watch: ${w.id}: when the answer is ready, the hopper ends this job's own wait (HOPPER_WAITING) with it.\n` };
      }
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
        // A watch another part opened (`owner`, issue #1072: `pr wait`) is its own to answer; a skill request's names none.
        if (w.body.owner !== undefined) continue;
        // A change heard while the watch is asked again: asked once more after, so no change is missed.
        if (busy.has(w.id)) { again.add(w.id); continue; }
        busy.add(w.id);
        try {
          do {
            again.delete(w.id);
            const a = await o.broker.again(userId, w.jobId, w.id, w.body);
            if (a !== undefined && a.status !== 202) {
              if (u.stream.finish(w.jobId, w.id, a.status === 200 ? 'skill.loaded' : 'skill.refused', a.text)) u.endWait?.(w.jobId, a.text);
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
