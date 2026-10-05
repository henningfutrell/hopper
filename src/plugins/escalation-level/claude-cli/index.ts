// claude-cli: an escalation level that answers with the `claude` CLI in print mode, locked down
// (design.md "Question pipeline"). Returns `{ answer, escalate, reason }` or `{ error }`; the core
// escalates on anything but a valid `escalate: false` with an answer. With `machine`, claude runs on
// that attached machine through its ssh connection, signed in to that machine's Claude account
// (issue #150): the hopper that has no claude CLI — the container — designates one that does.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { commandOn } from '../../../executors/command.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import { CLAUDE_TIMEOUT_MS, claudeModelChoices, claudePrint, detectClaude, ON_MACHINE, type ClaudePrintOptions } from '../../claude-print.ts';
import type { LevelReply, MachineSnapshot, PluginDefinition } from '../../sdk.ts';
import { buildLevelPrompt } from './prompt.ts';

export interface ClaudeCliOptions {
  bin: string;
  model: string;
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  machine?: string;
  sshBin: string;
}

const JSON_SCHEMA = {
  type: 'object',
  properties: { answer: { type: 'string' }, escalate: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['answer', 'escalate', 'reason'],
  additionalProperties: false,
};

const REPLY: z.ZodType<LevelReply> = z.object({ answer: z.string(), escalate: z.boolean(), reason: z.string() });

/** Why claude cannot run on this machine, or undefined. ssh only: a client serves herdr, and `docker exec` here passes no stdin. */
function refusal(id: string, m: MachineSnapshot | undefined): string | undefined {
  if (!m) return `machine ${id} is not configured`;
  if (!m.online) return `machine ${id} is offline`;
  if (m.client) return `machine ${id} is a client target: it serves herdr only`;
  if (m.docker) return `machine ${id} is a container target: claude-cli runs only here or over ssh`;
  return undefined;
}

const claudeCli: PluginDefinition<'escalation-level', ClaudeCliOptions> = {
  id: 'claude-cli',
  role: 'escalation-level',
  describe: 'Answers or escalates with the claude CLI (print mode, no tools) — here, or on a designated machine; a model alias such as opus, sonnet or fable',
  options: (zod) => zod.object({
    bin: zod.string().min(1).default('claude').meta({ commandBearing: true }),
    model: zod.string().min(1).default('opus'),
    timeoutMs: zod.number().int().positive().default(CLAUDE_TIMEOUT_MS),
    effort: zod.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    machine: zod.string().min(1).optional().meta({ description: 'an attached ssh machine that runs claude for this level (its own Claude account); absent: this machine' }),
    sshBin: zod.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for the machine' }),
  }),
  // On a machine, nothing to look for here: whether it runs shows in each question's trail.
  detect: async (sys, o) => (o.machine ? { status: 'available', detail: `claude on machine ${o.machine}` } : detectClaude(sys, o.bin)),
  choices: (sys) => claudeModelChoices(sys, 'model'),
  create(ctx, o) {
    const run: ClaudePrintOptions = { bin: o.bin, model: o.model, ...(o.effort ? { effort: o.effort } : {}), cwd: ctx.dataDir, timeoutMs: o.timeoutMs, jsonSchema: JSON_SCHEMA };
    const sshControlDir = join(ctx.dataDir, 'ssh');
    return {
      name: 'claude-cli',
      model: o.model,
      async answer(req, signal) {
        if (!o.machine) return claudePrint(run, REPLY, buildLevelPrompt(req), signal);
        const id = o.machine;
        const m = await ctx.machine(id);
        const refused = refusal(id, m);
        if (refused) return { error: refused };
        mkdirSync(sshControlDir, { recursive: true, mode: 0o700 });
        const wrap = (argv: string[]) => commandOn(m!, ['sh', '-c', ON_MACHINE, 'sh', ...argv], {
          sshBin: o.sshBin, sshControlDir, sshAuth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }),
          dockerHost: () => { throw new Error('no docker'); },
        });
        try {
          return await claudePrint({ ...run, wrap }, REPLY, buildLevelPrompt(req), signal);
        } catch (e) {
          return { error: `machine ${id}: ${e instanceof Error ? e.message : String(e)}` };
        }
      },
    };
  },
};

export default claudeCli;
