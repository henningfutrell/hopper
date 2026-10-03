// Superseded payload schemas, kept so stored events still read and their docs/schemas files stay
// exported. Stored events are never rewritten (design.md "Persisted-state migrations"); each
// entry is exactly the schema that version was written against.
import { z } from 'zod';
import { adviceAction, holdPlan, jobStatus, lanePlan, startPlan } from './parts.ts';

const strict = z.strictObject;
const jevMode = z.enum(['shadow', 'active']);
const answerTier = z.enum(['opus', 'fable', 'human']);

const jevAdvice = strict({
  action: adviceAction,
  reason: z.string(), jevUsed: z.boolean(), details: z.record(z.string(), z.unknown()),
  source: z.string(), at: z.string(),
});
const jevDivergence = strict({
  jobId: z.string(), advice: jevAdvice.shape.action,
  native: z.enum(['start', 'hold']), withJev: z.enum(['start', 'hold']), note: z.string(),
});

/** Types nothing emits any more; their stored events still read. */
export const LEGACY_EVENT_TYPES = ['jev.mode_changed'] as const;

/** `<type>.v<N>` → the payload schema of that superseded version. */
export const LEGACY_EVENT_SCHEMAS: Readonly<Record<string, z.ZodType>> = {
  'job.prioritized.v1': strict({ advice: jevAdvice, mode: jevMode, statusAtAdvice: jobStatus }),
  'decision.made.v1': strict({
    decisionId: z.string(), trigger: z.string(), jevMode,
    starts: z.array(startPlan), holds: z.array(holdPlan), lanes: z.array(lanePlan), divergences: z.array(jevDivergence),
  }),
  'jev.mode_changed.v1': strict({ from: jevMode, to: jevMode }),
  'question.escalated.v1': strict({
    questionId: z.string(), target: answerTier, reason: z.string(), text: z.string(), jobId: z.string(),
    goal: z.string().optional(), answerUrl: z.string().optional(),
    notifyCount: z.number().int().optional(), renotify: z.boolean().optional(),
  }),
  'question.answered.v1': strict({ questionId: z.string(), by: answerTier, answer: z.string() }),
};
