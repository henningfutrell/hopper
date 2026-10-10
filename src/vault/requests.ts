// The dynamic vault (issue #583, design.md "The dynamic vault"): a job on a box loads a skill that needs a credential
// (`sh "$HOPPER_SKILL" SERVICE --credential "<what it takes>"`) and its template gives none; the hopper asks a person for one — a credential request —
// and the job waits. A person gives one (any kind: the hopper suggests, never insists) or declines. The credential
// becomes a vault secret, write-only as any other, added to the template's scope; the job then gets it just in time
// through the vault's helper. Requests are kept in memory: a job that still waits asks again, and that opens its
// request again after a restart.
import type { Clock, UserStore } from '../domain/ports.ts';
import type { Job } from '../domain/types.ts';
import { CREDENTIAL_NOTE_MAX, CREDENTIAL_WHY_MAX, givesOf, VAULT_SECRET_NAME, type CredentialRequest, type VaultSecret } from '../domain/vault.ts';

/** The kind a person gives in their own words, whatever the skill. */
export const OTHER_KIND = 'other';

/** What a job's skill load asks the vault for: the skill, and the credential it takes, as the skill says it (src/skills/). */
export interface CredentialAsk {
  skill: string;
  title: string;
  /** Whether the hopper has the skill; false: the job said what it takes. */
  known: boolean;
  kinds: { id: string; title: string }[];
  setup: string;
  why?: string;
}

/** Who asks: the job, the box it runs on, the template the box joined as (proven by the skill broker). */
export interface Asker { job: Job; machine: string; template: string }

/** The answer: a person is asked (or the template waits for approval), or the person declined. */
export type NeedAnswer = { waiting: string } | { declined: string };

/** A person's answer: a vault secret name, the kind they give, their words for it, and a value (or none: the secret named exists). */
export interface Give { name: string; kind: string; note?: string; value?: string; scope?: string }

export type RequestResult = { ok: true } | { ok: false; code: 'invalid' | 'not_found' | 'conflict' | 'unavailable'; error: string };

export interface CredentialRequests {
  /** A job waits on a credential its template does not give: a request opened, or joined. */
  need(ask: CredentialAsk, asker: Asker): NeedAnswer;
  give(id: string, g: Give, by: string): Promise<RequestResult>;
  decline(id: string, reason: string, by: string): RequestResult;
  /** The open requests, without the jobs no longer at work, and with the secrets a person may give again. */
  list(): CredentialRequest[];
}

const AT_WORK = ['running', 'waiting_answer'];
const oneLine = (s: string | undefined, max: number): string | undefined => {
  const t = s?.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};
const invalid = (error: string): RequestResult => ({ ok: false, code: 'invalid', error });
const gone: RequestResult = { ok: false, code: 'not_found', error: 'no open credential request with that id: no job waits on it any more' };

export function createCredentialRequests(o: {
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>;
  clock: Clock;
  idGen: () => string;
  /** The vault's own set — in the hopper, or in the vault's container (issue #586): sealed, never kept in clear. */
  set(s: { name: string; scope?: string; value: string }, by: string): Promise<RequestResult>;
}): CredentialRequests {
  const { vault, events } = o.store;
  const open = new Map<string, CredentialRequest>();
  /** A declined request's reason, by job: told to each job that waited on it, once. */
  const declined = new Map<string, Map<string, string>>();
  const now = (): string => o.clock.now().toISOString();
  const keyOf = (template: string, skill: string): string => `${template}\0${skill}`;
  const atWork = (job: string): boolean => AT_WORK.includes(o.store.jobs.get(job)?.status ?? '');
  /** The secrets a person may give without a new value: those given for the skill before, and one of its name. */
  const givenBefore = (r: CredentialRequest): VaultSecret[] => vault.list().filter((s) => s.skill === r.skill || (s.skill === undefined && s.name === r.secret));
  const byId = (id: string): CredentialRequest | undefined => {
    prune();
    return [...open.values()].find((x) => x.id === id);
  };

  /** Drop the jobs no longer at work, and a request no job waits on. */
  function prune(): void {
    for (const [key, r] of open) {
      r.asked = r.asked.filter((a) => atWork(a.job));
      if (r.asked.length === 0) open.delete(key);
    }
    for (const job of declined.keys()) if (!atWork(job)) declined.delete(job);
  }

  return {
    need(ask, { job, machine, template }) {
      const key = keyOf(template, ask.skill);
      const said = declined.get(job.id)?.get(key);
      if (said !== undefined) {
        declined.get(job.id)!.delete(key);
        return { declined: `the user declined to give a credential for ${ask.title}: ${said}. Go on without it, or fail the job with that reason.` };
      }
      const t = vault.template(template);
      const pending = t ? t.secrets.filter((n) => !givesOf(t).includes(n)).map((n) => vault.get(n)).find((s) => s?.skill === ask.skill) : undefined;
      if (pending) return { waiting: `the user gave ${pending.name} for ${ask.title}; template ${template} waits for a person's approval in Settings → Vault.` };
      prune();
      const at = now();
      const why = oneLine(ask.why, CREDENTIAL_WHY_MAX);
      let r = open.get(key);
      if (!r) {
        r = { id: o.idGen(), skill: ask.skill, title: ask.title, known: ask.known, template, secret: ask.skill, kinds: ask.kinds, setup: ask.setup, asked: [], existing: [], createdAt: at };
        open.set(key, r);
      }
      if (!r.asked.some((a) => a.job === job.id)) {
        r.asked.push({ job: job.id, machine, ...(why ? { why } : {}), at });
        events.append({ type: 'vault.credential_asked', jobId: job.id, machineId: machine, data: { request: r.id, skill: ask.skill, template, machine, job: job.id, ...(why ? { why } : {}) } });
      }
      return { waiting: `the hopper asked the user for ${ask.kinds[0]?.title ?? 'a credential'} for ${ask.title} (they may give another kind).` };
    },

    async give(id, g, by) {
      const r = byId(id);
      if (!r) return gone;
      if (!VAULT_SECRET_NAME.test(g.name)) return invalid('name must be a letter, then letters, digits, `_`, `.` or `-`, at most 64');
      if (g.kind !== OTHER_KIND && !r.kinds.some((k) => k.id === g.kind)) return invalid(`${g.kind} is no kind of ${r.title} credential: ${[...r.kinds.map((k) => k.id), OTHER_KIND].join(', ')}`);
      const note = oneLine(g.note, CREDENTIAL_NOTE_MAX);
      if (g.kind === OTHER_KIND && !note) return invalid('say what you give, so the job knows how to use it');
      if (g.kind === 'access-key' && g.value !== undefined && !isKeyPair(g.value)) return invalid('an access key pair is JSON with AccessKeyId and SecretAccessKey');
      const was = vault.get(g.name);
      if (g.value === undefined && !was) return invalid(`the vault holds no secret ${g.name}: give its value`);
      if (was?.skill !== undefined && was.skill !== r.skill) return invalid(`${g.name} is the ${was.skill} credential; give this one another name`);
      if (!vault.template(r.template)) return { ok: false, code: 'not_found', error: `no template ${r.template}` };
      if (g.value !== undefined) {
        const set = await o.set({ name: g.name, value: g.value, ...(g.scope !== undefined ? { scope: g.scope } : {}) }, by);
        if (!set.ok) return set;
      }
      return o.store.tx(() => {
        const t = vault.template(r.template);
        const s = vault.get(g.name);
        if (!t || !s) return { ok: false, code: 'not_found', error: `no template ${r.template}, or no secret ${g.name}` } as const;
        const { note: _was, ...rest } = s;
        // Its metadata only: the value stays as the vault keeps it (sealed, or in a vault backend, issue #585).
        vault.replace({ ...rest, skill: r.skill, kind: g.kind, ...(note ? { note } : {}) }, vault.sealed(s.id) ?? null);
        // The person gives it for this template's boxes: that approves the widening by this one secret, and nothing more.
        // A template never approved, or whose image changed, still waits for a person on Settings → Vault.
        const approves = t.approval !== undefined && t.approval.image === t.image;
        vault.saveTemplate({
          ...t, secrets: t.secrets.includes(g.name) ? t.secrets : [...t.secrets, g.name],
          ...(approves ? { approval: { ...t.approval!, secrets: [...new Set([...t.approval!.secrets, g.name])], by, at: now() } } : {}),
        });
        open.delete(keyOf(r.template, r.skill));
        events.append({ type: 'vault.credential_given', data: { request: r.id, skill: r.skill, name: g.name, kind: g.kind, template: r.template, by, approved: approves, jobs: r.asked.map((a) => a.job) } });
        return { ok: true } as const;
      });
    },

    decline(id, reason, by) {
      const r = byId(id);
      if (!r) return gone;
      const why = oneLine(reason, CREDENTIAL_NOTE_MAX) ?? 'no reason given';
      for (const a of r.asked) declined.set(a.job, (declined.get(a.job) ?? new Map<string, string>()).set(keyOf(r.template, r.skill), why));
      open.delete(keyOf(r.template, r.skill));
      events.append({ type: 'vault.credential_declined', data: { request: r.id, skill: r.skill, template: r.template, reason: why, by, jobs: r.asked.map((a) => a.job) } });
      return { ok: true };
    },

    list() {
      prune();
      return [...open.values()].map((r) => ({ ...r, asked: [...r.asked], existing: givenBefore(r).map((s) => s.name) }));
    },
  };
}

function isKeyPair(value: string): boolean {
  try {
    const v = JSON.parse(value) as Record<string, unknown>;
    return typeof v.AccessKeyId === 'string' && typeof v.SecretAccessKey === 'string';
  } catch {
    return false;
  }
}
