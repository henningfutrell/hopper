// The artifacts' events (issue #624, design.md "Artifacts"): what a job made for a person to see, its shares, its
// revisions (issue #675) and its end. On the job's timeline. Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';
import { SHARE_KINDS } from '../domain/types.ts';

const strict = z.strictObject;
const artifactSettings = z.strictObject({
  maxBytes: z.number().int().min(1), userBytes: z.number().int().min(1), retentionDays: z.number().int().min(1),
  publicLinks: z.boolean(), linkHours: z.number().int().min(1), linkHoursMax: z.number().int().min(1), linkBase: z.string().optional(), // linkBase: issue #673, absent before it
});

export const ARTIFACT_EVENT_SCHEMAS = {
  'artifact.created': strict({
    artifact: z.string(), title: z.string(), name: z.string(), type: z.string(), size: z.number().int().min(1), sha256: z.string(),
    summary: z.string().optional(), issue: z.string().optional(), masked: z.number().int().min(1).optional(), warning: z.string().optional(),
  }),
  'artifact.shared': strict({ artifact: z.string(), share: z.string(), with: z.enum(SHARE_KINDS), user: z.string().optional(), expiresAt: z.iso.datetime().optional(), by: z.string() }),
  'artifact.share_revoked': strict({ artifact: z.string(), share: z.string(), with: z.enum(SHARE_KINDS), by: z.string() }),
  'artifact.removed': strict({ artifact: z.string(), reason: z.enum(['removed', 'retention']), by: z.string().optional() }),
  'artifact.settings_changed': strict({ from: artifactSettings, to: artifactSettings, by: z.string() }),
  // Artifact revisions (issue #675): what changed, who changed it, never the content.
  'artifact.revised': strict({
    artifact: z.string(), revision: z.number().int().min(2), title: z.string(), name: z.string(), type: z.string(), size: z.number().int().min(1),
    sha256: z.string(), by: z.string(), note: z.string().optional(), restoredFrom: z.number().int().min(1).optional(),
    masked: z.number().int().min(1).optional(), warning: z.string().optional(),
  }),
  'artifact.revision_pinned': strict({ artifact: z.string(), revision: z.number().int().min(1), pinned: z.boolean(), by: z.string() }),
  'artifact.revision_removed': strict({ artifact: z.string(), revision: z.number().int().min(1), reason: z.enum(['retention']) }),
  'artifact.posted': strict({ artifact: z.string(), title: z.string(), by: z.string(), comment: z.string().optional(), error: z.string().optional(), issue: z.literal(false).optional() }),
} as const;
