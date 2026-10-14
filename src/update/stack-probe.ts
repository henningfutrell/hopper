// What the hopper sees of its stack (issue #697, the StackProbe port): a service's name on the compose network, and the
// commit the vault in its own container answers at /health. Each ask is bounded: a stack that does not answer is a gap.
// The service the hopper's database runs in runs while that database answers (issue #1108): the hopper works against it,
// and a rootless Podman stack can fail the name lookup of a service that runs and is healthy.
import { lookup } from 'node:dns/promises';
import type { StackProbe } from '../domain/ports.ts';

const TIMEOUT_MS = 3000;

const within = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => { setTimeout(() => resolve(fallback), TIMEOUT_MS).unref(); })]);

/** Whether the database answers a read; it throws, or says false, when it does not. */
export type DatabaseAnswers = () => boolean;

/**
 * The probe of the stack the hopper runs in; `vaultUrl`: HOPPER_VAULT_URL, the vault in its own container; `database`: the
 * host of HOPPER_DATABASE_URL, and whether that database answers.
 */
export function createStackProbe(o: { vaultUrl?: string; database?: { host: string; answers: DatabaseAnswers } }): StackProbe {
  const databaseAnswers = (): boolean => { try { return o.database!.answers(); } catch { return false; } };
  return {
    resolves: async (service) => (service === o.database?.host && databaseAnswers()) || within(lookup(service).then(() => true), false),
    vaultCommit: async () => {
      if (!o.vaultUrl) return null;
      const body = await within(fetch(new URL('/health', o.vaultUrl), { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => (r.ok ? r.json() : null)), null);
      const commit = (body as { commit?: unknown } | null)?.commit;
      return typeof commit === 'string' ? commit : null;
    },
  };
}

/** The database HOPPER_DATABASE_URL names, for the probe: its host, and `answers`; undefined when the URL names no host. */
export function databaseHostOf(url: string, answers: DatabaseAnswers): { host: string; answers: DatabaseAnswers } | undefined {
  try {
    const host = new URL(url).hostname;
    return host ? { host, answers } : undefined;
  } catch {
    return undefined;
  }
}
