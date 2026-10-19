// The vault secrets the vault delivered to a job (issue #1957, design.md "Checkpoints and resume elsewhere"): a job's
// checkpoint is scrubbed of their values. A vault secret is a value a person set, with no pattern a scrub could know it
// by, and a job that read one — a box's job, a box or Windows step's output it saw — may keep it in its agent session
// or its work. The deliveries are the events `vault.delivered` and `vault.step_delivered` of the job; each secret named
// is read now, as a delivery reads it. One that cannot be read now (gone, a minting credential, a backend that does not
// answer) is left out: its value never left the vault through this job, or a scrub cannot know it.
import type { UserStore } from '../domain/ports.ts';
import { isSharedSecret, isSystemSecret, type VaultSecret } from '../domain/vault.ts';

/** The most deliveries of one job read: a job asks for a few secrets, each a few times. */
const DELIVERIES_READ = 1000;

export interface Delivered {
  /** The values of the user's own vault secrets the vault delivered to the job `jobId`, each once. A secret not read now is left out. */
  deliveredTo(jobId: string): Promise<string[]>;
}

/** The names of the secrets the vault delivered to the job `jobId`, each once, from its delivery events. */
export const deliveredNames = (events: UserStore['events'], jobId: string): string[] =>
  [...new Set(events.recent(DELIVERIES_READ, ['vault.delivered', 'vault.step_delivered'], jobId).map((e) => String(e.data.name)))];

export function deliveredValues(
  store: Pick<UserStore, 'vault' | 'events'>, valueOf: (secret: VaultSecret) => Promise<{ value: string } | { refused: string }>,
): Delivered {
  return { deliveredTo: async (jobId) => {
    const values = new Set<string>();
    for (const name of deliveredNames(store.events, jobId)) {
      if (isSystemSecret(name) || isSharedSecret(name)) continue;
      const secret = store.vault.get(name);
      if (!secret || secret.mints) continue;
      const r = await valueOf(secret).catch(() => ({ refused: 'unreadable' }));
      if ('value' in r && r.value) values.add(r.value);
    }
    return [...values];
  } };
}
