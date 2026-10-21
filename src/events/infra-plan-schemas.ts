// The infra plans' events (issue #870, design.md "Infra plans: no apply without a plan"): a plan a job recorded, its
// approval (a person's, or the hopper's with auto-approve on), a person's rejection (issue #2368), an admin turning auto-approve on or off, and the environment
// watchers an admin named (part 4). On the job's
// timeline. Part of EVENT_SCHEMAS (schemas.ts). Never the plan's text or file.
// Out-of-band changes (issue #871, design.md "Out-of-band changes"): a change a job's check reported, a person's mark on
// it, the controller identities changed. A topology report (issue #1781): its sources' counts, never their nodes. Never the signal's detail. A person's confirmation asked for (issue #909, design.md
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
  // `auto` and `level` (part 3, approval by risk): the hopper approved it itself; the plan's risk level, when it has a summary.
  'infra.plan_approved': strict({ plan: z.string(), tool: z.enum(PLAN_TOOLS), asset, target: z.string(), by: z.string(), auto: z.literal(true).optional(), level: z.enum(['low', 'high']).optional() }),
  // Issue #2368: a person rejected it, with why; it is never approved after.
  'infra.plan_rejected': strict({ plan: z.string(), tool: z.enum(PLAN_TOOLS), asset, target: z.string(), by: z.string(), note: z.string() }),
  'infra.applies_changed': strict({ on: z.boolean(), by: z.string() }),
  'infra.settings_changed': strict({ from: strict({ autoApprove: z.boolean() }), to: strict({ autoApprove: z.boolean() }), by: z.string() }),
  // Part 4: an admin named who watches each environment; `from` and `to` are the whole lists.
  'infra.watchers_changed': strict({ from: z.record(z.string(), z.array(z.string())), to: z.record(z.string(), z.array(z.string())), by: z.string() }),
  'infra.out_of_band_recorded': strict({
    change: z.string(), source: z.enum(SIGNAL_SOURCES), key: z.string(), target: z.string(), what: z.string(), who: z.string().optional(), at: z.string(),
    job: z.string().optional(), issue: z.string().optional(), reporter: z.string().optional(),
  }),
  'infra.out_of_band_marked': strict({
    change: z.string(), source: z.enum(SIGNAL_SOURCES), target: z.string(), what: z.string(), mark: z.enum(MARKS), reason: z.string().optional(), by: z.string(),
  }),
  'infra.controllers_changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.string() }),
  // The infrastructure topology (issue #1781): each source a read-only check reported, with its counts or why it failed; never a node.
  'infra.topology_reported': strict({
    reporter: z.string(),
    sources: z.array(strict({ key: z.string(), ok: z.boolean(), error: z.string().optional(), nodes: z.number().int().min(0).optional(), links: z.number().int().min(0).optional() })),
  }),
  'approval.confirmation_asked': strict({
    kind: z.enum(CONFIRMATION_KINDS), ref: z.string(), words: z.string(), asker: z.string(),
    plan: z.string().optional(), template: z.string().optional(), operation: z.enum(OPERATIONS).optional(), asset: asset.optional(),
  }),
} as const;
