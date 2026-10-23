// Payload schema of a push's evaluation (issue #2555, design.md "Push requirements"), split from schemas.ts for its line
// budget: each requirement's status, and each check's command, thresholds and measured values, for the commit evaluated.
import { z } from 'zod';
import { REQUIREMENT_LEVELS } from '../domain/push-requirements.ts';

const strict = z.strictObject;
const threshold = strict({ min: z.number().optional(), max: z.number().optional() });
const check = strict({
  name: z.string(), run: z.string(), exit: z.number().int(), thresholds: z.record(z.string(), threshold).optional(),
  measured: z.record(z.string(), z.number()).optional(), ci: strict({ checks: z.array(z.string()), minutes: z.number().optional() }).optional(), passed: z.boolean(), problem: z.string().optional(),
});
const requirement = strict({
  id: z.string(), level: z.enum(REQUIREMENT_LEVELS), status: z.enum(['passed', 'failed', 'skipped']), reason: z.string().optional(), checks: z.array(check).optional(),
});

export const PUSH_REQUIREMENT_EVENT_SCHEMAS = {
  'push_requirements.evaluated': strict({
    repo: z.string(), branch: z.string(), base: z.string(), head: z.string(), passed: z.boolean(), requirements: z.array(requirement),
  }),
  'push_requirements.defaults_changed': strict({ from: z.array(z.string()), to: z.array(z.string()), by: z.string() }),
  'push_requirements.summarized': strict({ repo: z.string(), number: z.number().int(), head: z.string() }),
  'push_requirements.ci_missed': strict({
    repo: z.string(), pullRequest: z.string(), head: z.string(), checks: z.array(z.string()), requirements: z.array(z.string()), minutes: z.number().optional(),
  }),
};
