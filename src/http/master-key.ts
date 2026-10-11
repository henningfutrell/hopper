// The master key (issue #659, design.md "The master key"): GET /api/master-key, the banner's source — where this start's
// key came from, whether a person saved it, and why there is none. Never the key. Every signed-in person reads it: a
// limited hopper says so to everyone; only the hopper's admin may reveal the key (POST /ui/api/master-key, ui/instance.ts).
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { InstanceSettingsRepository, MasterKeyResealed } from '../domain/ports.ts';
import type { MasterKeyRotated, MasterKeyView } from '../domain/types.ts';
import { fingerprintOf, shortFingerprint, type MasterKey } from '../secrets/master-key.ts';
import { HttpError } from './errors.ts';

/** The master key's status: what the banner shows, the one reveal of a key this start made or read from the old token key, a person's word that they saved it, and a rotation. */
export interface MasterKeyStatus {
  view(): MasterKeyView;
  /** The key, the first time it is asked for, when this start made it or read it from the old token key; else undefined. */
  reveal(): string | undefined;
  /** A person saved this key: the banner asks no more. */
  saved(): MasterKeyView;
  /** A new key, every secret sealed again under it, the running hopper on it; the new key answered this once. `by` pressed it. Throws HttpError 409 when it cannot. */
  rotate(by: string): MasterKeyRotated;
}

/**
 * The rotation's work, given by the composition root (issue #659): seal every secret again from the current keys to the
 * new one, in one transaction, and move the running hopper onto it. Absent: this hopper cannot rotate, and `why` says so.
 */
export type RotateMasterKey = ((o: { from: { key: string; previous: readonly string[] }; to: string; by: string }) => MasterKeyResealed) | { why: string };

export function createMasterKeyStatus(initial: MasterKey, settings: Pick<InstanceSettingsRepository, 'masterKeySaved' | 'setMasterKeySaved'>, rotation: RotateMasterKey = { why: 'this hopper cannot rotate its master key' }): MasterKeyStatus {
  let key = initial;
  let shown = key.source === 'given' || key.source === 'missing' ? undefined : key.key;
  const isSaved = (): boolean => key.fingerprint !== undefined && settings.masterKeySaved() === key.fingerprint;
  // A key no one saved is shown once in the UI; one saved is never shown again.
  if (isSaved()) shown = undefined;
  const view = (): MasterKeyView => ({
    source: key.source,
    ...(key.fingerprint ? { fingerprint: shortFingerprint(key.fingerprint) } : {}),
    previous: key.source !== 'missing' && key.previous.length > 0,
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
    rotate(by) {
      if (key.source === 'missing') throw new HttpError(409, `the master key cannot be rotated: ${key.problem}`);
      if (typeof rotation !== 'function') throw new HttpError(409, rotation.why);
      const next = randomBytes(32).toString('hex');
      // Synchronous from here on: no other request runs between the transaction and the switch to the new key.
      const done = rotation({ from: { key: key.key, previous: key.previous }, to: next, by });
      key = { source: 'rotated', key: next, previous: [], fingerprint: fingerprintOf(next), notes: [] };
      shown = undefined;
      return { ...view(), key: next, ...done };
    },
  };
}

export function masterKeyRoutes(app: FastifyInstance, o: { masterKey: Pick<MasterKeyStatus, 'view'> }): void {
  app.get('/api/master-key', async (): Promise<MasterKeyView> => o.masterKey.view());
}
