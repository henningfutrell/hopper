// claude-plan: Claude subscription usage as usage readings (design.md "Usage and accounts (issue
// #18)"). `claude -p /usage` is a local slash command — zero turns, zero tokens — and Claude Code
// refreshes its own OAuth, so nothing here holds a credential. It runs in the background every
// `intervalSeconds`; `poll` answers from the last good read and never waits on claude. The
// session and the week of all models throttle lanes; a window of one model is informational.
// `claude auth status` gives the account, refreshed with the usage.
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Account, UsageReading, UsageSourceState } from '../../../domain/types.ts';
import type { UsageSource } from '../../../domain/ports.ts';
import type { PluginDefinition } from '../../sdk.ts';
import { parseAuthStatus, parseUsageEnvelope, type PlanWindow } from './parse.ts';
import { runCli, type CliRun } from './run.ts';

export interface ClaudePlanOptions { bin: string; intervalSeconds: number }

/** Each claude call is killed after this long. */
const TIMEOUT_MS = 45_000;
/** Readings older than this many intervals are stale: none are returned. */
const STALE_INTERVALS = 3;

const USAGE_ARGS = ['-p', '/usage', '--output-format', 'json', '--no-session-persistence'];
const AUTH_ARGS = ['auth', 'status', '--json'];

const failed = (what: string, r: CliRun): string => `claude ${what} failed: ${'error' in r ? r.error : `exited ${r.code}: ${r.stderr.trim().slice(0, 300)}`}`;

/** The project dir `claude` keeps for a working directory: every non-alphanumeric as `-`. */
const projectDirOf = (cwd: string): string =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

function createClaudePlanSource(ctx: { clock: { now(): Date }; logger: { info(l: string): void; warn(l: string): void }; scratchDir: string; instanceName: string }, o: ClaudePlanOptions): UsageSource {
  // 0700 and ours alone: `/usage` reads no context from its cwd today, but a shared or
  // world-writable one would be an injection point if that changed. Its project dir under
  // ~/.claude/projects is ours alone too, so it is removed whole after every run.
  const probe = join(ctx.scratchDir, 'probe');
  const staleMs = STALE_INTERVALS * o.intervalSeconds * 1000;
  let windows: PlanWindow[] = [];
  let refreshedAt: Date | undefined;
  let lastError: string | undefined;
  let account: Account | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  const abort = new AbortController();

  const run = async (args: string[]): Promise<CliRun> => {
    mkdirSync(probe, { recursive: true, mode: 0o700 });
    chmodSync(probe, 0o700);
    try {
      return await runCli(o.bin, args, { cwd: probe, timeoutMs: TIMEOUT_MS, signal: abort.signal });
    } finally {
      rmSync(projectDirOf(probe), { recursive: true, force: true });
    }
  };

  const note = (problem: string | undefined) => {
    if (problem === lastError) return;
    if (problem) ctx.logger.warn(`hopper: usage source ${ctx.instanceName}: ${problem}`);
    else ctx.logger.info(`hopper: usage source ${ctx.instanceName}: reading Claude usage`);
    lastError = problem;
  };

  const refresh = async (): Promise<void> => {
    const usage = await run(USAGE_ARGS);
    if (stopped) return;
    const parsed = 'stdout' in usage && usage.code === 0 ? parseUsageEnvelope(usage.stdout, ctx.clock.now()) : { problem: failed('-p /usage', usage) };
    if ('windows' in parsed) {
      windows = parsed.windows;
      refreshedAt = ctx.clock.now();
    }
    note('problem' in parsed ? parsed.problem : undefined);
    const auth = await run(AUTH_ARGS);
    if (stopped) return;
    // Logged out, `auth status` exits non-zero and still prints its JSON.
    account = 'stdout' in auth && auth.stdout.trim() ? parseAuthStatus(auth.stdout) : { service: 'claude', detail: {}, problem: failed('auth status', auth) };
  };

  const kick = () => {
    if (running || stopped) return;
    running = refresh()
      .catch((e: unknown) => note(`refresh failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { running = undefined; });
  };

  const stale = (now: Date) => refreshedAt !== undefined && now.getTime() - refreshedAt.getTime() > staleMs;

  kick();
  const timer = setInterval(kick, o.intervalSeconds * 1000);
  timer.unref();

  return {
    name: ctx.instanceName,
    async poll(): Promise<UsageReading[]> {
      const now = ctx.clock.now();
      if (!refreshedAt || stale(now)) return [];
      const at = refreshedAt.toISOString();
      // A window past its reset no longer says anything: it is left out until the next read.
      return windows.filter((w) => !w.resetsAt || Date.parse(w.resetsAt) > now.getTime()).map((w) => ({
        source: ctx.instanceName, window: w.window, used: w.used, limit: 100, unit: '%',
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}), ...(w.informational ? { informational: true as const } : {}), at,
      }));
    },
    state(): UsageSourceState {
      const now = ctx.clock.now();
      const problem = stale(now)
        ? `stale: last read ${refreshedAt!.toISOString()}${lastError ? ` (${lastError})` : ''}`
        : (lastError ?? (refreshedAt ? undefined : 'not read yet'));
      return {
        ...(refreshedAt ? { refreshedAt: refreshedAt.toISOString() } : {}),
        ...(problem ? { problem } : {}),
        ...(account ? { account } : {}),
      };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      abort.abort();
    },
  };
}

const claudePlan: PluginDefinition<'usage-source', ClaudePlanOptions> = {
  id: 'claude-plan',
  role: 'usage-source',
  describe: 'Claude subscription usage (session and week throttle lanes; a window of one model is shown only) and the Claude account, from the claude CLI',
  options: (z) => z.object({
    bin: z.string().min(1).default('claude').meta({ commandBearing: true, description: 'the claude CLI' }),
    intervalSeconds: z.number().int().min(120).default(600).meta({ description: 'seconds between reads (each is a local command: no tokens)' }),
  }),
  // `which` only: never a call to claude, so never a paid one.
  async detect(sys, o) {
    const path = await sys.which(o.bin);
    return path ? { status: 'available', detail: path } : { status: 'unavailable', reason: `claude not found: ${o.bin}` };
  },
  create: (ctx, o) => createClaudePlanSource(ctx, o),
};

export default claudePlan;
