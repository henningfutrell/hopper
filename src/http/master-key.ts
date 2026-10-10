// The master key (issue #659, design.md "The master key"): GET /api/master-key, the banner's source — where this start's
// key came from, whether a person saved it, and why there is none. Never the key. Every signed-in person reads it: a
// limited hopper says so to everyone; only the hopper's admin may reveal the key (POST /ui/api/master-key, ui/instance.ts).
import type { FastifyInstance } from 'fastify';
import type { InstanceSettingsRepository } from '../domain/ports.ts';
import type { MasterKeyView } from '../domain/types.ts';
import { shortFingerprint, type MasterKey } from '../secrets/master-key.ts';

/** The master key's status: what the banner shows, the one reveal of a key this start made or read from the old token key, and a person's word that they saved it. */
export interface MasterKeyStatus {
  view(): MasterKeyView;
  /** The key, the first time it is asked for, when this start made it or read it from the old token key; else undefined. */
  reveal(): string | undefined;
  /** A person saved this key: the banner asks no more. */
  saved(): MasterKeyView;
}

export function createMasterKeyStatus(key: MasterKey, settings: Pick<InstanceSettingsRepository, 'masterKeySaved' | 'setMasterKeySaved'>): MasterKeyStatus {
  let shown = key.source === 'given' || key.source === 'missing' ? undefined : key.key;
  const isSaved = (): boolean => key.fingerprint !== undefined && settings.masterKeySaved() === key.fingerprint;
  // A key no one saved is shown once in the UI; one saved is never shown again.
  if (isSaved()) shown = undefined;
  const view = (): MasterKeyView => ({
    source: key.source,
    ...(key.fingerprint ? { fingerprint: shortFingerprint(key.fingerprint) } : {}),
    saved: key.source === 'given' || isSaved(),
    revealable: shown !== undefined,
    ...(key.source === 'missing' ? { problem: key.problem } : {}),
  });
  return {
    view,
    reveal() {
      const k = shown;
      shown = undefined;
      return k;
    },
    saved() {
      if (key.source !== 'missing' && key.source !== 'given') {
        settings.setMasterKeySaved(key.fingerprint);
        shown = undefined;
      }
      return view();
    },
  };
}

export function masterKeyRoutes(app: FastifyInstance, o: { masterKey: Pick<MasterKeyStatus, 'view'> }): void {
  app.get('/api/master-key', async (): Promise<MasterKeyView> => o.masterKey.view());
}
