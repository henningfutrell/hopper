// The infra plans' events (issue #870, design.md "Infra plans: no apply without a plan"): a plan a job recorded, and a
// person's approval of it. On the job's timeline. Part of EVENT_SCHEMAS (schemas.ts). Never the plan's text or file.
// Out-of-band changes (issue #871, design.md "Out-of-band changes"): a change a job's check reported, a person's mark on
// it, the controller identities changed. Never the signal's detail. A person's confirmation asked for (issue #909, design.md
// "A person confirms what an agent asks"): an API token's approval of a high-risk plan or a write profile, not done.
import { z } from 'zod';
import { ASSET_KINDS, OPERATIONS } from '../domain/access.ts';
import { CONFIRMATION_KINDS } from '../domain/confirmation-asks.ts';
import { PLAN_RISKS } from '../domain/infra-plan-summary.ts';
import { PLAN_TOOLS } from '../domain/infra-plans.ts';
import { MARKS, SIGNAL_SOURCES } from '../domain/out-of-band.ts';

const strict = z.strictObject;
const asset = strict({ kind: z.enum(ASSET_KINDS), name: z.string() });

export const INFRA_PLAN_EVENT_SCHEMAS = {
  'infra.plan_recorded': strict({
    plan: z.string(), tool: z.enum(PLAN_TOOLS), asset, target: z.string(), repo: z.string(), ref: z.string(), commit: z.string(),
    pullRequest: z.number().int().min(1).optional(), read: z.string().optional(), issue: z.string().optional(), file: z.boolean(), expiresAt: z.iso.datetime(),
    // Optional: a plan recorded before the summary (issue #870 part 2) has none.
    summary: strict({ words: z.string(), level: z.enum(['low', 'high']), risks: z.array(z.enum(PLAN_RISKS)), failed: z.boolean() }).optional(),
  }),
  'infra.plan_approved': strict({ plan: z.string(), tool: z.enum(PLAN_TOOLS), asset, target: z.string(), by: z.string() }),
  'infra.out_of_band_recorded': strict({
    change: z.string(), source: z.enum(SIGNAL_SOURCES), key: z.string(), target: z.string(), what: z.string(), who: z.string().optional(), at: z.string(),
    job: z.string().optional(), issue: z.string().optional(), reporter: z.string().optional(),
  }),
  'infra.out_of_band_marked': strict({
    change: z.string(), source: z.enum(SIGNAL_SOURCES), target: z.string(), what: z.string(), mark: z.enum(MARKS), reason: z.string().optional(), by: z.string(),
  }),
  'infra.controllers_changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.string() }),
  'approval.confirmation_asked': strict({
    kind: z.enum(CONFIRMATION_KINDS), ref: z.string(), words: z.string(), asker: z.string(),
    plan: z.string().optional(), template: z.string().optional(), operation: z.enum(OPERATIONS).optional(), asset: asset.optional(),
  }),
} as const;
