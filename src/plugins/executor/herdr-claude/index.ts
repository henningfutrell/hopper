// herdr-claude: one Claude Code job per tab of job-hopper's own herdr session (design.md
// "herdr-claude executor"). The screen protocol parses Claude Code's TUI, so the agent kind is
// fixed: another agent CLI is another executor plugin. `args` are the agent's own arguments —
// where its tools are chosen (design.md "6d"). A job on an attached machine runs in that machine's
// herdr session of the same name, reached over ssh (design.md "Attached machines").
import { join } from 'node:path';
import type { HerdrClient } from '../../../executors/herdr/index.ts';
import { createHerdrClaudeExecutor, createHerdrCliClient } from '../../../executors/herdr/index.ts';
import { expandHome } from '../../expand-home.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface HerdrClaudeOptions {
  bin: string;
  claudeBin: string;
  session: string;
  args: string[];
  cwd: string;
  trustWorkdir: boolean;
  pollMs: number;
  idleQuestionMs: number;
}

/**
 * The plugin. `seam` (tests, `AppSeams.herdr`) replaces the herdr CLI client; detection then
 * says available, since nothing is run.
 */
export function herdrClaudePlugin(seam?: HerdrClient): PluginDefinition<'executor', HerdrClaudeOptions> {
  return {
    id: 'herdr-claude',
    role: 'executor',
    describe: 'Claude Code in a pane of job-hopper\'s own herdr session, one tab per job',
    options: (z) => z.object({
      bin: z.string().min(1).default('herdr').meta({ commandBearing: true, description: 'the herdr CLI' }),
      claudeBin: z.string().min(1).default('claude')
        .meta({ commandBearing: true, description: 'the claude CLI herdr starts (detection checks it is on PATH)' }),
      // Never the user's default herdr session (herdr's own doctrine; design.md "herdr session").
      session: z.string().min(1).refine((s) => s !== 'default', 'must not be the default herdr session').default('job-hopper'),
      args: z.array(z.string()).default(['--dangerously-skip-permissions'])
        .meta({ commandBearing: true, description: "Claude Code's arguments: permissions, allowed tools, MCP config" }),
      cwd: z.string().min(1).default('~/workbench/app-workflows').transform(expandHome)
        .meta({ commandBearing: true, description: 'working directory of a job whose payload names none' }),
      trustWorkdir: z.boolean().default(true),
      pollMs: z.number().int().positive().default(1000),
      idleQuestionMs: z.number().int().positive().default(20000),
    }),
    async detect(sys, o) {
      if (seam) return { status: 'available', detail: 'herdr seam (tests)' };
      const herdr = await sys.which(o.bin);
      if (!herdr) return { status: 'unavailable', reason: `herdr not found: ${o.bin}` };
      const claude = await sys.which(o.claudeBin);
      if (!claude) return { status: 'unavailable', reason: `claude not found: ${o.claudeBin}` };
      return { status: 'available', detail: `${herdr}, ${claude}` };
    },
    create(ctx, o) {
      // One client per attached machine; their ssh connections share sockets under the data dir
      // (a unix socket path is capped at 108 bytes: keep the data dir short).
      const remotes = new Map<string, HerdrClient>();
      const remote = (target: string): HerdrClient => {
        let client = remotes.get(target);
        if (!client) {
          client = seam ?? createHerdrCliClient({ bin: o.bin, session: o.session, ssh: { target, controlDir: join(ctx.dataDir, 'ssh') } });
          remotes.set(target, client);
        }
        return client;
      };
      return createHerdrClaudeExecutor({
        herdr: seam ?? createHerdrCliClient({ bin: o.bin, session: o.session }), remote,
        clock: ctx.clock, defaultCwd: o.cwd, claudeArgs: o.args, trustWorkdir: o.trustWorkdir,
        pollMs: o.pollMs, idleQuestionMs: o.idleQuestionMs,
      });
    },
  };
}

export default herdrClaudePlugin();
