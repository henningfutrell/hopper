// anthropic-api: an escalation level that answers through the Claude API (Messages, structured
// output bound to the level reply) with an API key the runtime gives (issue #150). It needs no
// claude CLI and no machine, so a hopper in a container can settle questions below the owner. The
// key is never stored: `apiKeyEnv` names the variable, or its `_FILE` mount (design.md "Secrets").
// One request per question, no tools. Returns `{ answer, escalate, reason }` or `{ error }`; a
// refusal, an API error or a reply off the schema escalates.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { CLAUDE_TIMEOUT_MS } from '../../claude-print.ts';
import type { LevelReply, PluginDefinition } from '../../sdk.ts';
import { buildLevelPrompt } from '../claude-cli/prompt.ts';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface AnthropicApiOptions {
  model: string;
  apiKeyEnv: string;
  baseUrl?: string;
  timeoutMs: number;
  effort?: Effort;
}

const REPLY = z.object({ answer: z.string(), escalate: z.boolean(), reason: z.string() });

const MAX_TOKENS = 16000;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const anthropicApi: PluginDefinition<'escalation-level', AnthropicApiOptions> = {
  id: 'anthropic-api',
  role: 'escalation-level',
  describe: 'Answers or escalates through the Claude API with an API key the runtime gives — no claude CLI needed; a model id such as claude-opus-5-5',
  options: (zod) => zod.object({
    model: zod.string().min(1).default('claude-opus-5-5').meta({ description: 'the Claude model id' }),
    apiKeyEnv: zod.string().regex(/^[A-Z][A-Z0-9_]*$/).default('ANTHROPIC_API_KEY')
      .meta({ commandBearing: true, description: 'the runtime variable holding the API key (or <name>_FILE, a mounted file)' }),
    baseUrl: zod.string().url().optional().meta({ commandBearing: true, description: 'where the API key is sent; absent: the Claude API' }),
    timeoutMs: zod.number().int().positive().default(CLAUDE_TIMEOUT_MS),
    effort: zod.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  }),
  // The key is there; never a call to the API, so never a paid one.
  async detect(sys, o) {
    if (!sys.env(o.apiKeyEnv)) return { status: 'unavailable', reason: `no API key: set ${o.apiKeyEnv} or ${o.apiKeyEnv}_FILE` };
    return { status: 'available', detail: `${o.model} with the key in ${o.apiKeyEnv}` };
  },
  create(ctx, o) {
    return {
      name: 'anthropic-api',
      model: o.model,
      async answer(req, signal): Promise<(LevelReply & { model?: string }) | { error: string }> {
        let apiKey: string | undefined;
        try {
          apiKey = ctx.env(o.apiKeyEnv);
        } catch (e) {
          return { error: message(e) };
        }
        if (!apiKey) return { error: `no API key: set ${o.apiKeyEnv} or ${o.apiKeyEnv}_FILE` };
        // Read per question, so a rotated key is used at the next one.
        const client = new Anthropic({ apiKey, ...(o.baseUrl ? { baseURL: o.baseUrl } : {}), maxRetries: 2 });
        const timeout = AbortSignal.timeout(o.timeoutMs);
        try {
          const res = await client.messages.parse({
            model: o.model,
            max_tokens: MAX_TOKENS,
            messages: [{ role: 'user', content: buildLevelPrompt(req) }],
            output_config: { format: zodOutputFormat(REPLY), ...(o.effort ? { effort: o.effort } : {}) },
          }, { signal: AbortSignal.any([signal, timeout]) });
          if (res.stop_reason === 'refusal') return { error: `the model refused${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}` };
          const parsed = REPLY.safeParse(res.parsed_output);
          if (!parsed.success) return { error: 'structured output missing or invalid' };
          return { ...parsed.data, model: res.model };
        } catch (e) {
          if (timeout.aborted) return { error: `timeout after ${o.timeoutMs}ms` };
          if (signal.aborted) return { error: 'aborted' };
          if (e instanceof Anthropic.APIError && e.status) return { error: `Claude API ${e.status}: ${message(e).slice(0, 300)}` };
          return { error: `Claude API: ${message(e).slice(0, 300)}` };
        }
      },
    };
  },
};

export default anthropicApi;
