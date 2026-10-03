// claude-cli: the answerer that drafts with the `claude` CLI in print mode, locked down
// (design.md "Question pipeline"). Returns `{ answer, confident, reason }` or `{ error }`.
import { z } from 'zod';
import { CLAUDE_TIMEOUT_MS, claudePrint, detectClaude } from '../../claude-print.ts';
import type { AnswerDraft, PluginDefinition } from '../../sdk.ts';
import { buildAnswerPrompt } from './prompt.ts';

export interface ClaudeCliOptions {
  bin: string;
  model: string;
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

const JSON_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, confident: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['answer', 'confident', 'reason'],
  additionalProperties: false,
};

const DRAFT: z.ZodType<AnswerDraft> = z.object({ answer: z.string(), confident: z.boolean(), reason: z.string() });

const claudeCli: PluginDefinition<'answerer', ClaudeCliOptions> = {
  id: 'claude-cli',
  role: 'answerer',
  describe: "Drafts answers with the claude CLI (print mode, no tools); a model alias such as opus, sonnet or fable",
  options: (zod) => zod.object({
    bin: zod.string().min(1).default('claude'),
    model: zod.string().min(1).default('opus'),
    timeoutMs: zod.number().int().positive().default(CLAUDE_TIMEOUT_MS),
    effort: zod.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
  detect: (sys, o) => detectClaude(sys, o.bin),
  create(ctx, o) {
    const run = { bin: o.bin, model: o.model, ...(o.effort ? { effort: o.effort } : {}), cwd: ctx.dataDir, timeoutMs: o.timeoutMs, jsonSchema: JSON_SCHEMA };
    return {
      name: 'claude-cli',
      model: o.model,
      answer: (req, signal) => claudePrint(run, DRAFT, buildAnswerPrompt(req), signal),
    };
  },
};

export default claudeCli;
