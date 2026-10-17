// Intake's events (issue #440): a claim released, a source moved to the current intake rules, issues assigned to the user
// from Sources; and (issue #652) a person approved a request card's text, the user's trusted actors changed, a job queued
// before origins were judged got its origin; (issue #798) a new request card opened, and an item taken off the backburner;
// (issue #1035) a person declined a request card's text; (issue #1079) a GitHub delivery named a job repository; (issue
// #1268) the hopper approved a request card a rule matched, and the auto-approval setting changed; (issue #1710) GitHub took a
// decline's writes, and the decline defaults changed.
// Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';
import { JOB_ORIGINS, ORIGIN_ROLES } from '../domain/intake-origin.ts';
import { AUTO_APPROVE_RULES } from '../domain/intake-auto-approve.ts';
import { DECLINE_CHOICES } from '../domain/intake-decline.ts';
import { ACTION_VIAS } from '../domain/types.ts';

const strict = z.strictObject;

export const INTAKE_EVENT_SCHEMAS = {
  'source.claim_released': strict({ source: z.string(), key: z.string(), by: z.enum(['hopper', 'migration', 'user']), reason: z.string() }),
  'source.intake_migrated': strict({ source: z.string(), changes: z.array(strict({ key: z.string(), change: z.string() })) }),
  'source.issues_assigned': strict({ source: z.string(), keys: z.array(z.string()), assignee: z.string() }),
  'source.request_approved': strict({
    source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(),
    person: z.string().optional(), via: z.enum(ACTION_VIAS).optional(),
    actors: z.array(strict({ role: z.enum(ORIGIN_ROLES), login: z.string().optional(), app: z.string().optional(), trusted: z.boolean() })),
  }),
  'source.request_auto_approved': strict({
    source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(), rule: z.enum(AUTO_APPROVE_RULES), actor: z.string(),
    actors: z.array(strict({ role: z.enum(ORIGIN_ROLES), login: z.string().optional(), app: z.string().optional(), trusted: z.boolean() })),
  }),
  'source.request_opened': strict({ source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(), why: z.array(z.string()) }),
  'source.backburner_lifted': strict({ source: z.string(), key: z.string() }),
  'source.issue_taken_in': strict({ source: z.string(), key: z.string(), pullRequest: z.string(), assignee: z.string() }),
  'source.review_requested': strict({ source: z.string(), key: z.string(), author: z.string() }),
  'source.request_declined': strict({
    source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(),
    person: z.string().optional(), via: z.enum(ACTION_VIAS).optional(), choice: z.enum(DECLINE_CHOICES).optional(),
  }),
  'source.request_decline_written': strict({ source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), choice: z.enum(DECLINE_CHOICES) }),
  'source.delivery_received': strict({
    sources: z.array(z.string()).min(1), delivery: z.string(), event: z.string(), action: z.string().optional(), repo: z.string(), number: z.number().int().positive().optional(),
  }),
  'intake.actors_changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.string() }),
  'intake.auto_approval_changed': strict({
    from: strict({ on: z.boolean(), apps: z.array(z.string()) }), to: strict({ on: z.boolean(), apps: z.array(z.string()) }), by: z.string(),
  }),
  'intake.decline_changed': strict({
    from: strict({ request: z.enum(DECLINE_CHOICES), reopened: z.enum(DECLINE_CHOICES) }), to: strict({ request: z.enum(DECLINE_CHOICES), reopened: z.enum(DECLINE_CHOICES) }), by: z.string(),
  }),
  'job.origin_judged': strict({ key: z.string(), origin: z.enum(JOB_ORIGINS) }),
};
