// The infra plans' events (issue #870, design.md "Infra plans: no apply without a plan"): a plan a job recorded, and a
// person's approval of it. On the job's timeline. Part of EVENT_SCHEMAS (schemas.ts). Never the plan's text or file.
import { z } from 'zod';
import { ASSET_KINDS } from '../domain/access.ts';
import { PLAN_RISKS } from '../domain/infra-plan-summary.ts';
import { PLAN_TOOLS } from '../domain/infra-plans.ts';

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
} as const;
