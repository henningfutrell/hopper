// Intake's events (issue #440): a claim released, a source moved to the current intake rules, issues assigned to the user
// from Sources; and (issue #652) a person approved a request card's text, the user's trusted actors changed, a job queued
// before origins were judged got its origin; (issue #798) a new request card opened, and an item taken off the backburner;
// (issue #1035) a person declined a request card's text.
// Part of EVENT_SCHEMAS (schemas.ts).
import { z } from 'zod';
import { JOB_ORIGINS } from '../domain/intake-origin.ts';
import { ACTION_VIAS } from '../domain/types.ts';

const strict = z.strictObject;

export const INTAKE_EVENT_SCHEMAS = {
  'source.claim_released': strict({ source: z.string(), key: z.string(), by: z.enum(['hopper', 'migration', 'user']), reason: z.string() }),
  'source.intake_migrated': strict({ source: z.string(), changes: z.array(strict({ key: z.string(), change: z.string() })) }),
  'source.issues_assigned': strict({ source: z.string(), keys: z.array(z.string()), assignee: z.string() }),
  'source.request_approved': strict({
    source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(),
    person: z.string().optional(), via: z.enum(ACTION_VIAS).optional(),
    actors: z.array(strict({ role: z.enum(['author', 'labelled', 'assigned']), login: z.string().optional(), app: z.string().optional(), trusted: z.boolean() })),
  }),
  'source.request_opened': strict({ source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(), why: z.array(z.string()) }),
  'source.backburner_lifted': strict({ source: z.string(), key: z.string() }),
  'source.request_declined': strict({
    source: z.string(), key: z.string(), hash: z.string().regex(/^[0-9a-f]{64}$/), author: z.string(),
    person: z.string().optional(), via: z.enum(ACTION_VIAS).optional(),
  }),
  'intake.actors_changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.string() }),
  'job.origin_judged': strict({ key: z.string(), origin: z.enum(JOB_ORIGINS) }),
};
