// A Windows sandbox step's vault secret (issue #731, design.md "Windows sandbox steps"): the hopper asks for it for a
// running job's step on a Windows host, after it checked the job's proxy token and that the host gives the secret; the
// job's vault grant is checked around this (grants.ts). Here, wherever the vault runs: the job at work, the user's own
// secret, not a minting credential, opened or read in its backend. Every outcome an event, never with the value. A step
// schedule's run (issue #2716) has no job: its schedule's vault grant is checked by the hopper before it asks.
import type { Clock, UserStore } from '../domain/ports.ts';
import { isSharedSecret, isSystemSecret, type VaultSecret } from '../domain/vault.ts';
import { AT_WORK } from './box.ts';

/**
 * What a Windows sandbox step asks the vault for: a secret, for a job's step on a Windows host. A box step (issue #1875)
 * asks the same, `host` its need box and `template` the box's template. A step schedule's run (issue #2716) names its
 * `schedule` in place of a job: the hopper checked the schedule's vault grant before it asked.
 */
export type StepSecretAsk = { name: string; host: string; template?: string } & ({ job: string; schedule?: undefined } | { schedule: string; job?: undefined });

export interface StepDelivery {
  /**
   * A Windows sandbox step's secret, asked by the hopper for a running job's step on the Windows host `host`. The value,
   * or why not. The step gets it in its environment; the job never does.
   */
  forStep(ask: StepSecretAsk): Promise<{ value: string } | { refused: string }>;
}

export function stepDelivery(
  store: Pick<UserStore, 'vault' | 'events' | 'tx' | 'jobs'>, clock: Clock,
  valueOf: (secret: VaultSecret) => Promise<{ value: string } | { refused: string }>,
): StepDelivery {
  const { vault, events } = store;
  return { forStep: async (ask) => {
    const job = ask.job !== undefined ? store.jobs.get(ask.job) : undefined;
    const who = ask.job !== undefined ? { jobId: ask.job, data: { job: ask.job } } : { data: { schedule: ask.schedule } };
    const refuse = (reason: string, backend?: string): { refused: string } => {
      events.append({ type: 'vault.step_refused', ...(who.jobId ? { jobId: who.jobId } : {}), data: { name: ask.name, host: ask.host, ...who.data, ...(backend ? { backend } : {}), reason } });
      return { refused: reason };
    };
    if (ask.job !== undefined && (!job || !AT_WORK.includes(job.status))) return refuse(`the job is not at work (${job?.status ?? 'no such job'}): the vault gives only while it runs`);
    if (isSystemSecret(ask.name) || isSharedSecret(ask.name)) return refuse(`${ask.name} is not one of the user's own vault secrets: a step gets only those`);
    const secret = vault.get(ask.name);
    if (!secret) return refuse(`the vault holds no secret ${ask.name}`);
    if (secret.mints) return refuse(`${ask.name} is a minting credential: the hopper mints from it and never gives it out`);
    const { backend } = secret;
    const r = await valueOf(secret);
    if ('refused' in r) return refuse(r.refused, backend?.name);
    const at = clock.now().toISOString();
    store.tx(() => {
      const now = vault.get(ask.name);
      if (now?.id === secret.id) vault.replace({ ...now, lastUsed: { at, machine: ask.host, ...(job ? { job: job.id } : { schedule: ask.schedule! }) } }, vault.sealed(secret.id) ?? null);
      events.append({ type: 'vault.step_delivered', ...(who.jobId ? { jobId: who.jobId } : {}), data: { name: ask.name, host: ask.host, ...who.data, ...(backend ? { backend: backend.name } : {}) } });
    });
    return { value: r.value };
  } };
}
