// claude-cli: an escalation level that answers with the `claude` CLI in print mode, locked down
// (design.md "Question pipeline"). Returns `{ answer, escalate, reason }` or `{ error }`; the core
// escalates on anything but a valid `escalate: false` with an answer.
import { z } from 'zod';
import { CLAUDE_TIMEOUT_MS, claudePrint, detectClaude } from '../../claude-print.ts';
import type { LevelReply, PluginDefinition } from '../../sdk.ts';
import { buildLevelPrompt } from './prompt.ts';

export interface ClaudeCliOptions {
  bin: string;
  model: string;
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

const JSON_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, escalate: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['answer', 'escalate', 'reason'],
  additionalProperties: false,
};

const REPLY: z.ZodType<LevelReply> = z.object({ answer: z.string(), escalate: z.boolean(), reason: z.string() });

const claudeCli: PluginDefinition<'escalation-level', ClaudeCliOptions> = {
  id: 'claude-cli',
  role: 'escalation-level',
  describe: 'Answers or escalates with the claude CLI (print mode, no tools); a model alias such as opus, sonnet or fable',
  options: (zod) => zod.object({
    bin: zod.string().min(1).default('claude').meta({ commandBearing: true }),
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
      answer: (req, signal) => claudePrint(run, REPLY, buildLevelPrompt(req), signal),
    };
  },
};

export default claudeCli;
