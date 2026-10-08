// claude-cli: an escalation level that answers with the `claude` CLI in print mode, locked down
// (design.md "Question pipeline"). Returns `{ answer, escalate, reason }` or `{ error }`; the core
// escalates on anything but a valid `escalate: false` with an answer. claude runs on the level's
// `machine`, signed in to that machine's Claude account (issue #150): this machine, the `local` one in
// the list, an attached one through its ssh connection, or a client target through its client, which runs
// its own claude with the same lockdown (`POST /level`, issue #482); never a container target (`docker
// exec` passes no stdin). Named, never a default (issue #174) — but a
// level stored with none (a fresh plugins config, issue #259) picks one per question, in a set order, and
// the trail says which and why; none can: it escalates, saying so plainly (issue #442).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { clientLevel, type ClientTransport } from '../../../executors/client.ts';
import { commandOn } from '../../../executors/command.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import { CLAUDE_TIMEOUT_MS, claudeModelChoices, claudePrint, ON_MACHINE, parsePrint, type ClaudePrintOptions } from '../../claude-print.ts';
import { containerRefusal, notConfigured, offlineNote, pickMachine } from '../../../domain/machine-pick.ts';
import type { AnswerRequest, LevelReply, MachineSnapshot, PluginDefinition } from '../../sdk.ts';
import { buildLevelPrompt } from './prompt.ts';

export interface ClaudeCliOptions {
  bin: string;
  model: string;
  timeoutMs: number;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Absent: picked per question (issue #442). */
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

/** Why claude cannot run on this machine, and how to fix it; or undefined. Never a container target: `docker exec` here passes no stdin. */
function refusal(id: string, m: MachineSnapshot | undefined): string | undefined {
  if (!m) return notConfigured(id);
  if (!m.online) return offlineNote(id, m.client ? 'client' : m.ssh ? 'ssh' : 'other');
  if (m.docker) return containerRefusal(id);
  return undefined;
}

/** Resolves `work`, or 'aborted' once `signal` aborts. */
const unlessAborted = <T>(work: Promise<T>, signal: AbortSignal): Promise<T | 'aborted'> => (signal.aborted ? Promise.resolve('aborted') : new Promise((resolve, reject) => {
  const onAbort = () => resolve('aborted');
  signal.addEventListener('abort', onAbort, { once: true });
  work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
}));

const claudeCli: PluginDefinition<'escalation-level', ClaudeCliOptions> = {
  id: 'claude-cli',
  role: 'escalation-level',
  describe: 'Answers or escalates with the claude CLI (print mode, no tools) on the machine it names; a model alias such as opus, sonnet or fable',
  options: (zod) => zod.object({
    bin: zod.string().min(1).default('claude').meta({ commandBearing: true }),
    model: zod.string().min(1).default('opus'),
    timeoutMs: zod.number().int().positive().default(CLAUDE_TIMEOUT_MS),
    effort: zod.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    machine: zod.string().min(1).optional().meta({ machine: true, description: 'the machine that runs claude for this level (its own Claude account): this one, an ssh machine or a joined one; never a container' }),
    sshBin: zod.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for the machine' }),
  }),
  // claude runs on the machine, whichever it is: whether it runs shows in each question's trail.
  detect: async (_sys, o) => ({ status: 'available', detail: o.machine ? `claude on machine ${o.machine}` : 'claude on the machine each question picks' }),
  choices: (sys) => claudeModelChoices(sys, 'model'),
  create(ctx, o) {
    const run: ClaudePrintOptions = { bin: o.bin, model: o.model, ...(o.effort ? { effort: o.effort } : {}), cwd: ctx.dataDir, timeoutMs: o.timeoutMs, jsonSchema: JSON_SCHEMA, userEnv: ctx.userEnv };
    const sshControlDir = join(ctx.dataDir, 'ssh');
    /** On a client target, its client runs its own claude (`bin` names the hopper's), locked down the same way. */
    const answerOnClient = async (id: string, t: ClientTransport, req: AnswerRequest, signal: AbortSignal): Promise<LevelReply | { error: string }> => {
      const call = { model: o.model, ...(o.effort ? { effort: o.effort } : {}), jsonSchema: JSON_SCHEMA, prompt: buildLevelPrompt(req) };
      try {
        const r = await unlessAborted(clientLevel(t, call, o.timeoutMs), signal);
        if (r === 'aborted') return { error: 'aborted' };
        if (r.code === 124) return { error: `machine ${id}: claude timed out after ${o.timeoutMs} ms` };
        if (r.code !== 0) return { error: `machine ${id}: claude exited ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
        return parsePrint(r.stdout, REPLY);
      } catch (e) {
        return { error: `machine ${id}: ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    const answerOn = async (id: string, req: AnswerRequest, signal: AbortSignal): Promise<LevelReply | { error: string }> => {
      const m = await ctx.machine(id);
      const refused = refusal(id, m);
      if (refused) return { error: refused };
      if (m!.client) {
        const t = ctx.client(id);
        return t ? answerOnClient(id, t, req, signal) : { error: `machine ${id}: client ${id} is not dialled in` };
      }
      if (!m!.ssh) return claudePrint(run, REPLY, buildLevelPrompt(req), signal);
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
    };
    return {
      name: 'claude-cli',
      model: o.model,
      async answer(req, signal) {
        if (o.machine) return answerOn(o.machine, req, signal);
        const fallback = ctx.escalationMachine();
        const picked = pickMachine({ reach: 'no-container', machines: await ctx.machines(), ...(req.jobMachine ? { jobMachine: req.jobMachine } : {}), ...(fallback ? { fallback } : {}) });
        if ('none' in picked) return { escalate: true, reason: picked.none };
        const machine = { id: picked.machine, why: picked.why };
        const reply = await answerOn(picked.machine, req, signal);
        return 'error' in reply ? { error: `${reply.error} (picked as ${machine.why})` } : { ...reply, machine };
      },
    };
  },
};

export default claudeCli;
