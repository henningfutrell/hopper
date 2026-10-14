// What the hopper sees of its stack (issue #697, the StackProbe port): a service's name on the compose network, and the
// commit the vault in its own container answers at /health. Each ask is bounded: a stack that does not answer is a gap.
import { lookup } from 'node:dns/promises';
import type { StackProbe } from '../domain/ports.ts';

const TIMEOUT_MS = 3000;

const within = <T>(p: Promise<T>, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((resolve) => { setTimeout(() => resolve(fallback), TIMEOUT_MS).unref(); })]);

/** The probe of the stack the hopper runs in; `vaultUrl`: HOPPER_VAULT_URL, the vault in its own container. */
export function createStackProbe(o: { vaultUrl?: string }): StackProbe {
  return {
    resolves: (service) => within(lookup(service).then(() => true), false),
    vaultCommit: async () => {
      if (!o.vaultUrl) return null;
      const body = await within(fetch(new URL('/health', o.vaultUrl), { signal: AbortSignal.timeout(TIMEOUT_MS) }).then((r) => (r.ok ? r.json() : null)), null);
      const commit = (body as { commit?: unknown } | null)?.commit;
      return typeof commit === 'string' ? commit : null;
    },
  };
}
