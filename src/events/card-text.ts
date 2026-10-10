// Payload schemas of the events about a card's or an item's text (split from schemas.ts for its line budget):
// the TL;DR (issue #569) and item snapshots (issue #662). Never the item text itself.
import { z } from 'zod';
import { ACTION_VIAS, SNAPSHOT_REASONS, TLDR_KINDS } from '../domain/types.ts';

const strict = z.strictObject;
const acting = { person: z.string(), via: z.enum(ACTION_VIAS) };
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const tldrSettings = strict({ enabled: z.boolean() });

/** The TL;DR (issue #569): plain text a cheap model wrote for a long card, and the setting that turns it off. */
export const TLDR_EVENT_SCHEMAS = {
  'tldr.written': strict({ kind: z.enum(TLDR_KINDS), id: z.string(), text: z.string(), model: z.string().optional() }),
  'tldr.settings_changed': strict({ from: tldrSettings, to: tldrSettings, by: z.string() }),
};

/** Item snapshots (issue #662): hashes and who edited it, never the text. On the job's timeline. */
export const ITEM_EVENT_SCHEMAS = {
  'item.snapshot_recorded': strict({ key: z.string(), hash: sha256, reason: z.enum(SNAPSHOT_REASONS) }),
  'item.changed_since_snapshot': strict({ key: z.string(), snapshotHash: sha256, liveHash: sha256, editors: z.array(z.string()), newComments: z.number().int().min(0) }),
  'item.original_kept': strict({ key: z.string(), snapshotHash: sha256, liveHash: sha256, ...acting }),
  'item.new_text_accepted': strict({ key: z.string(), fromHash: sha256, toHash: sha256, editors: z.array(z.string()), ...acting }),
};
