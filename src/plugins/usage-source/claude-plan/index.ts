// claude-plan: Claude subscription usage as usage readings (design.md "Usage and accounts (issue
// #18)"). `claude -p /usage` is a local slash command — zero turns, zero tokens — and Claude Code
// refreshes its own OAuth, so nothing here holds a credential. It runs in the background every
// `intervalSeconds` (`polled.ts`); `poll` answers from the last good read and never waits on claude.
// The session and the week of all models throttle the jobs of `executors` — the Claude executors, not
// every job (issue #140); a window of one model is informational. `claude auth status` gives the
// account, refreshed with the usage. Both run on the source's `machine` — this machine, the `local`
// one in the list, or an attached one through its connection (ssh or docker exec, as the command
// executor) — and the readings are that machine's: its own Claude account (issue #139). The machine is
// always named, never a default (issue #174).
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { commandOn } from '../../../executors/command.ts';
import { dockerHost } from '../../../executors/docker.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import { ON_MACHINE } from '../../claude-print.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createPolledUsageSource, EXECUTORS_DESCRIPTION } from '../polled.ts';
import { runCli, type CliRun } from '../run.ts';
import { parseAuthStatus, parseUsageEnvelope } from './parse.ts';

export interface ClaudePlanOptions { bin: string; intervalSeconds: number; machine: string; sshBin: string; dockerBin: string; executors: string[] }

/** Each claude call is killed after this long. */
const TIMEOUT_MS = 45_000;

const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'];
const AUTH_ARGS = ['auth', 'status', '--json'];

const failed = (what: string, r: CliRun): string => `claude ${what} failed: ${'error' in r ? r.error : `exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`}`;

/** The project dir `claude` keeps for a working directory: every non-alphanumeric as `-`; in the user's claude config dir (issue #158). */
const projectDirOf = (cwd: string, userEnv: Readonly<Record<string, string>>): string =>
  join(userEnv.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

const claudePlan: PluginDefinition<'usage-source', ClaudePlanOptions> = {
  id: 'claude-plan',
  role: 'usage-source',
  describe: 'Claude subscription usage (session and week throttle the Claude executors\' jobs; a window of one model is shown only) and the Claude account, from the claude CLI on the machine it names',
  options: (z) => z.object({
    bin: z.string().min(1).default('claude').meta({ commandBearing: true, description: 'the claude CLI' }),
    intervalSeconds: z.number().int().min(120).default(600).meta({ description: 'seconds between reads (each is a local command: no tokens)' }),
    machine: z.string().min(1).meta({ machine: true, description: 'the machine to read the Claude account of (its usage caps that machine only): this one, or an attached one' }),
    sshBin: z.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for an ssh target' }),
    dockerBin: z.string().min(1).default('docker').meta({ commandBearing: true, description: 'the docker CLI, for a container target' }),
    // The built-in Claude Code executor instance; name the others that run Claude.
    executors: z.array(z.string().min(1)).min(1).default(['herdr-claude']).meta({ description: EXECUTORS_DESCRIPTION }),
  }),
  // claude runs on the machine, whichever it is: never a call to claude here. Whether it runs shows in the source's state.
  detect: async (_sys, o) => ({ status: 'available', detail: `claude on machine ${o.machine}` }),
  create(ctx, o) {
    // 0700 and ours alone: `/usage` reads no context from its cwd today, but a shared or
    // world-writable one would be an injection point if that changed. Its project dir under
    // ~/.claude/projects is ours alone too, so it is removed whole after every run.
    const probe = join(ctx.scratchDir, 'probe');
    const runHere = async (args: string[], signal: AbortSignal): Promise<CliRun> => {
      mkdirSync(probe, { recursive: true, mode: 0o700 });
      chmodSync(probe, 0o700);
      try {
        return await runCli(o.bin, args, { cwd: probe, timeoutMs: TIMEOUT_MS, signal, userEnv: ctx.userEnv });
      } finally {
        rmSync(projectDirOf(probe, ctx.userEnv), { recursive: true, force: true });
      }
    };
    const run = async (args: string[], signal: AbortSignal): Promise<CliRun> => {
      const id = o.machine;
      const m = await ctx.machine(id);
      if (!m) return { error: `machine ${id} is not configured` };
      if (!m.online) return { error: `machine ${id} is offline` };
      if (!m.ssh && !m.docker && !m.client) return runHere(args, signal);
      let file: string;
      let argv: string[];
      try {
        [file, argv] = commandOn(m, ['sh', '-c', ON_MACHINE, 'sh', o.bin, ...args], {
          sshBin: o.sshBin, dockerBin: o.dockerBin, sshControlDir: join(ctx.dataDir, 'ssh'),
          sshAuth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }), dockerHost: () => dockerHost(ctx.env),
        });
      } catch (e) {
        return { error: `machine ${id}: ${e instanceof Error ? e.message : String(e)}` };
      }
      return runCli(file, argv, { cwd: ctx.scratchDir, timeoutMs: TIMEOUT_MS, signal });
    };
    /** A failure of the run itself (no machine, offline): the reason as it is, not as claude's. */
    const notReady = (r: CliRun): boolean => 'error' in r && r.error.startsWith('machine ');
    const failure = (what: string, r: CliRun): string => (notReady(r) && 'error' in r ? r.error : failed(what, r));
    return createPolledUsageSource(ctx, {
      intervalSeconds: o.intervalSeconds, executors: o.executors, machineId: o.machine,
      async read(signal) {
        const usage = await run(USAGE_ARGS, signal);
        const parsed = 'stdout' in usage && usage.code === 0 ? parseUsageEnvelope(usage.stdout, ctx.clock.now()) : { problem: failure('-p /usage', usage) };
        const auth = await run(AUTH_ARGS, signal);
        // Logged out, `auth status` exits non-zero and still prints its JSON.
        const read = 'stdout' in auth && auth.stdout.trim() ? parseAuthStatus(auth.stdout) : { service: 'claude', detail: {}, problem: failure('auth status', auth) };
        const account = { ...read, detail: { ...read.detail, machine: o.machine } };
        // At start an attached machine is offline until its first probe: no reason to wait an interval.
        const retry = notReady(usage) ? { notReady: true } : {};
        if ('problem' in parsed) return { problem: parsed.problem, account, ...retry };
        return {
          budgets: parsed.windows.map((w) => ({
            window: w.window, used: w.used, limit: 100, unit: '%',
            ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(w.informational ? { informational: true as const } : {}),
          })),
          account,
          ...retry,
        };
      },
    });
  },
};

export default claudePlan;
