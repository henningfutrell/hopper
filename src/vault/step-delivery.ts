// A Windows sandbox step's vault secret (issue #731, design.md "Windows sandbox steps"): the hopper asks for it for a
// running job's step on a Windows host, after it checked the job's proxy token and that the host gives the secret; the
// job's vault grant is checked around this (grants.ts). Here, wherever the vault runs: the job at work, the user's own
// secret, not a minting credential, opened or read in its backend. Every outcome an event, never with the value.
import type { Clock, UserStore } from '../domain/ports.ts';
import { isSharedSecret, isSystemSecret, type VaultSecret } from '../domain/vault.ts';
import { AT_WORK } from './box.ts';

/** What a Windows sandbox step asks the vault for: a secret, for a job's step on a Windows host. */
export interface StepSecretAsk { name: string; job: string; host: string }

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
    const job = store.jobs.get(ask.job);
    const refuse = (reason: string, backend?: string): { refused: string } => {
      events.append({ type: 'vault.step_refused', jobId: ask.job, data: { name: ask.name, host: ask.host, job: ask.job, ...(backend ? { backend } : {}), reason } });
      return { refused: reason };
    };
    if (!job || !AT_WORK.includes(job.status)) return refuse(`the job is not at work (${job?.status ?? 'no such job'}): the vault gives only while it runs`);
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
      if (now?.id === secret.id) vault.replace({ ...now, lastUsed: { at, machine: ask.host, job: job.id } }, vault.sealed(secret.id) ?? null);
      events.append({ type: 'vault.step_delivered', jobId: job.id, data: { name: ask.name, host: ask.host, job: job.id, ...(backend ? { backend: backend.name } : {}) } });
    });
    return { value: r.value };
  } };
}
