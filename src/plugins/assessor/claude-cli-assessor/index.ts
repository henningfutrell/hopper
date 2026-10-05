// claude-cli-assessor: gives its own best answer with the `claude` CLI and decides whether the owner
// must see a question, under the same lockdown as the claude-cli answerer (design.md "Question
// pipeline"). Returns `{ answer, escalate, reason }` or `{ error }`; the core escalates on anything
// but a valid `escalate: false`.
import { z } from 'zod';
import { CLAUDE_TIMEOUT_MS, claudePrint, detectClaude } from '../../claude-print.ts';
import type { Assessment, PluginDefinition } from '../../sdk.ts';
import { buildAssessPrompt } from './prompt.ts';

export interface ClaudeCliAssessorOptions {
  bin: string;
  model: string;
  timeoutMs: number;
}

const JSON_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, escalate: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['answer', 'escalate', 'reason'],
  additionalProperties: false,
};

const ASSESSMENT: z.ZodType<Assessment> = z.object({ answer: z.string(), escalate: z.boolean(), reason: z.string() });

const claudeCliAssessor: PluginDefinition<'assessor', ClaudeCliAssessorOptions> = {
  id: 'claude-cli-assessor',
  role: 'assessor',
  describe: 'Gives its own best answer with the claude CLI (print mode, no tools) and decides whether the owner must see a question',
  options: (zod) => zod.object({
    bin: zod.string().min(1).default('claude').meta({ commandBearing: true }),
    model: zod.string().min(1).default('fable'),
    timeoutMs: zod.number().int().positive().default(CLAUDE_TIMEOUT_MS),
  }),
  detect: (sys, o) => detectClaude(sys, o.bin),
  create(ctx, o) {
    const run = { bin: o.bin, model: o.model, cwd: ctx.dataDir, timeoutMs: o.timeoutMs, jsonSchema: JSON_SCHEMA };
    return {
      name: 'claude-cli-assessor',
      model: o.model,
      assess: (req, draft, signal) => claudePrint(run, ASSESSMENT, buildAssessPrompt(req, draft), signal),
    };
  },
};

export default claudeCliAssessor;
