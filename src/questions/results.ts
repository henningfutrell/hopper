// The level replies the question service accepts (design.md "Question pipeline"): every escalation
// level's reply is validated here, so a plugin that breaks its contract escalates, it never answers.
import { z } from 'zod';

// Only this answers: a boolean `escalate` false, a string `reason`, and a non-empty `answer`.
// Escalating, the answer (a recommendation) is optional but never empty. `"false"`, a missing
// field, an empty answer or anything else is an error, and an error escalates.
export const REPLY = z.object({ answer: z.string().min(1).optional(), escalate: z.boolean(), reason: z.string(), model: z.string().optional() })
  .refine((r) => r.escalate || r.answer !== undefined, { path: ['answer'], message: 'required when escalate is false' });

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export function check<T>(schema: z.ZodType<T>, what: string, r: unknown): Checked<T> {
  if (typeof r === 'object' && r !== null && 'error' in r && typeof r.error === 'string') return { ok: false, error: r.error };
  const parsed = schema.safeParse(r);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, error: `${what} is malformed: ${parsed.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ')}` };
}
