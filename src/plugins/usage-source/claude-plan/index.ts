// claude-plan: Claude subscription usage as usage readings (design.md "Usage and accounts (issue
// #18)"). `claude -p /usage` is a local slash command — zero turns, zero tokens — and Claude Code
// refreshes its own OAuth, so nothing here holds a credential. It runs in the background every
// `intervalSeconds` (`polled.ts`); `poll` answers from the last good read and never waits on claude.
// The session and the week of all models throttle the jobs of `executors` — the Claude executors, not
// every job (issue #140); a window of one model is informational. `claude auth status` gives the
// account, refreshed with the usage. Both run on the source's `machine` — this machine, the `local`
// one in the list, or an attached one through its connection (ssh or docker exec, as the command
// executor; a client target through its client, which runs its own claude, issue #366) — and the
// readings are that machine's: its own Claude account (issue #139). The machine is named, never a default
// (issue #174); a source stored with none reads the only machine there is, at each read (issue #442).
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clientClaude } from '../../../executors/client.ts';
import { commandOn } from '../../../executors/command.ts';
import { dockerHost } from '../../../executors/docker.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import { pickMachine } from '../../../domain/machine-pick.ts';
import { ON_MACHINE } from '../../claude-print.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { createPolledUsageSource, EXECUTORS_DESCRIPTION } from '../polled.ts';
import { runCli, type CliRun } from '../run.ts';
import { parseAuthStatus, parseUsageEnvelope } from './parse.ts';

export interface ClaudePlanOptions { bin: string; intervalSeconds: number; machine?: string; sshBin: string; dockerBin: string; executors: string[] }

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
    bin: z.string().min(1).default('claude').meta({ commandBearing: true, description: 'the claude CLI (a client target runs its own)' }),
    intervalSeconds: z.number().int().min(120).default(600).meta({ description: 'seconds between reads (each is a local command: no tokens)' }),
    machine: z.string().min(1).optional().meta({ machine: true, description: 'the machine to read the Claude account of (its usage caps that machine only): this one, or an attached one' }),
    sshBin: z.string().min(1).default('ssh').meta({ commandBearing: true, description: 'the ssh client, for an ssh target' }),
    dockerBin: z.string().min(1).default('docker').meta({ commandBearing: true, description: 'the docker CLI, for a container target' }),
    // The built-in Claude Code executor instance; name the others that run Claude.
    executors: z.array(z.string().min(1)).min(1).default(['herdr-claude']).meta({ description: EXECUTORS_DESCRIPTION }),
  }),
  // claude runs on the machine, whichever it is: never a call to claude here. Whether it runs shows in the source's state.
  detect: async (_sys, o) => ({ status: 'available', detail: o.machine ? `claude on machine ${o.machine}` : 'claude on the only machine there is' }),
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
    const run = async (id: string, args: string[], signal: AbortSignal): Promise<CliRun> => {
      const m = await ctx.machine(id);
      if (!m) return { error: `machine ${id} is not configured` };
      if (!m.online) return { error: `machine ${id} is offline` };
      if (m.client) return runOnClient(id, args);
      if (!m.ssh && !m.docker) return runHere(args, signal);
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
    /** On a client target, its client runs its own claude: `bin` names the hopper's, not the machine's. */
    const runOnClient = async (id: string, args: string[]): Promise<CliRun> => {
      const t = ctx.client(id);
      if (!t) return { error: `machine ${id}: client ${id} is not dialled in` };
      try {
        return await clientClaude(t, args, TIMEOUT_MS);
      } catch (e) {
        return { error: `machine ${id}: ${e instanceof Error ? e.message : String(e)}` };
      }
    };
    /** A failure of the run itself (no machine, offline): the reason as it is, not as claude's. */
    const notReady = (r: CliRun): boolean => 'error' in r && r.error.startsWith('machine ');
    const failure = (what: string, r: CliRun): string => (notReady(r) && 'error' in r ? r.error : failed(what, r));
    return createPolledUsageSource(ctx, {
      intervalSeconds: o.intervalSeconds, executors: o.executors, ...(o.machine ? { machineId: o.machine } : {}),
      async read(signal) {
        // None named: the only machine there is now; none, or several: said, and tried again soon (a machine is probed online after start).
        const picked = o.machine ? { machine: o.machine } : pickMachine({ reach: 'any', machines: await ctx.machines() });
        if ('none' in picked) return { problem: picked.none, notReady: true };
        const id = picked.machine;
        const usage = await run(id, USAGE_ARGS, signal);
        const parsed = 'stdout' in usage && usage.code === 0 ? parseUsageEnvelope(usage.stdout, ctx.clock.now()) : { problem: failure('-p /usage', usage) };
        const auth = await run(id, AUTH_ARGS, signal);
        // Logged out, `auth status` exits non-zero and still prints its JSON.
        const read = 'stdout' in auth && auth.stdout.trim() ? parseAuthStatus(auth.stdout) : { service: 'claude', detail: {}, problem: failure('auth status', auth) };
        const account = { ...read, detail: { ...read.detail, machine: id } };
        // At start an attached machine is offline until its first probe: no reason to wait an interval.
        const retry = notReady(usage) ? { notReady: true } : {};
        if ('problem' in parsed) return { problem: parsed.problem, account, ...retry };
        return {
          machineId: id,
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
