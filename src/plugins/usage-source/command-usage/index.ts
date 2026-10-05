// command-usage: any agent framework's budget and account, from a command that prints them as JSON
// (design.md "Usage per executor (issue #140)"). The hopper does not know Codex, Gemini or the next
// CLI; the command does, and the readings limit the jobs of the `executors` named. It runs in the
// background every `intervalSeconds` (`polled.ts`), argv only, in a private probe dir.
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { PluginDefinition } from '../../sdk.ts';
import { createPolledUsageSource, EXECUTORS_DESCRIPTION, type Read } from '../polled.ts';
import { runCli } from '../run.ts';

export interface CommandUsageOptions { command: string[]; intervalSeconds: number; executors?: string[] }

/** Each run is killed after this long. */
const TIMEOUT_MS = 45_000;

/** What the command prints: its budgets, and who it read them for (facts only, never a token). */
const OUTPUT = z.object({
  readings: z.array(z.object({
    used: z.number().nonnegative(),
    limit: z.number(),
    unit: z.string().min(1),
    window: z.string().min(1).optional(),
    resetsAt: z.iso.datetime({ offset: true }).optional(),
    informational: z.literal(true).optional(),
  })),
  account: z.object({
    service: z.string().min(1),
    identity: z.string().min(1).optional(),
    detail: z.record(z.string(), z.union([z.string(), z.array(z.string())])).default({}),
    problem: z.string().min(1).optional(),
  }).optional(),
});

/** The command's stdout as a read, or why not. */
export function parseOutput(stdout: string): Read {
  let json: unknown;
  try { json = JSON.parse(stdout); } catch { return { problem: 'usage command output: not JSON' }; }
  const r = OUTPUT.safeParse(json);
  if (!r.success) return { problem: `usage command output: ${r.error.issues.map((i) => `${i.path.join('.') || 'output'}: ${i.message}`).join('; ')}` };
  const strip = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return { budgets: r.data.readings.map(strip), ...(r.data.account ? { account: strip(r.data.account) } : {}) };
}

const commandUsage: PluginDefinition<'usage-source', CommandUsageOptions> = {
  id: 'command-usage',
  role: 'usage-source',
  describe: 'Any agent framework\'s usage and account, from a command that prints them as JSON; its readings limit the jobs of the executors named',
  options: (zz) => zz.object({
    command: zz.array(zz.string().min(1)).min(1)
      .meta({ commandBearing: true, description: 'the command and its arguments (no shell); prints { readings: [{ used, limit, unit, window?, resetsAt?, informational? }], account? }' }),
    intervalSeconds: zz.number().int().min(60).default(600).meta({ description: 'seconds between reads' }),
    executors: zz.array(zz.string().min(1)).min(1).optional().meta({ description: EXECUTORS_DESCRIPTION }),
  }),
  // `which` only: never a run, so never a paid one.
  async detect(sys, o) {
    const bin = o.command[0]!;
    const path = await sys.which(bin);
    return path ? { status: 'available', detail: path } : { status: 'unavailable', reason: `not found: ${bin}` };
  },
  create(ctx, o) {
    const probe = join(ctx.scratchDir, 'probe');
    const [bin, ...args] = o.command as [string, ...string[]];
    return createPolledUsageSource(ctx, {
      intervalSeconds: o.intervalSeconds, ...(o.executors ? { executors: o.executors } : {}),
      async read(signal) {
        mkdirSync(probe, { recursive: true, mode: 0o700 });
        chmodSync(probe, 0o700);
        const r = await runCli(bin, args, { cwd: probe, timeoutMs: TIMEOUT_MS, signal });
        if ('error' in r) return { problem: `usage command failed: ${r.error}` };
        if (r.code !== 0) return { problem: `usage command failed: exited ${r.code}: ${r.stderr.trim().slice(0, 300)}` };
        return parseOutput(r.stdout);
      },
    });
  },
};

export default commandUsage;
