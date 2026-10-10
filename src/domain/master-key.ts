// The master key as people see it (issue #659, design.md "The master key"): where this start's key came from, whether
// a person saved it, and why there is none. Never the key: only POST /ui/api/master-key `reveal` answers it, once.

/** Where the master key of this start came from. */
export const MASTER_KEY_SOURCES = ['given', 'generated', 'old-token-key', 'missing'] as const;
export type MasterKeySource = typeof MASTER_KEY_SOURCES[number];

export interface MasterKeyView {
  /**
   * `given`: HOPPER_MASTER_KEY. `generated`: made at this first start, to save and give as HOPPER_MASTER_KEY. `old-token-key`:
   * read from the old token key, to save and give as HOPPER_MASTER_KEY. `missing`: none, while the database keeps secrets:
   * the hopper is limited — nothing is deleted, and what needs a secret stays off.
   */
  source: MasterKeySource;
  /** The first 16 hex digits of the key's fingerprint (an HMAC of a fixed label, never the key), when one is known. */
  fingerprint?: string;
  /** A person said they saved this key. */
  saved: boolean;
  /** `reveal` answers the key: this start made it or read it from the old token key, and no one has seen it in the UI yet. */
  revealable: boolean;
  /** `missing`: which key is missing, and how to give it. */
  problem?: string;
}
