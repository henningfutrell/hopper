// herdr-claude: one Claude Code job per tab of hopper's own herdr session (design.md
// "herdr-claude executor"). The screen protocol parses Claude Code's TUI, so the agent kind is
// fixed: another agent CLI is another executor plugin. `yolo` is the instance's choice whether Claude
// has every permission (design.md "Yolo", issue #267); `args` are the agent's other arguments —
// where its tools are chosen (design.md "6d"). A job on an attached machine runs in that machine's
// own herdr (binary and session from its `ssh` machine instance), reached over ssh (design.md "Attached machines"),
// or a client target's herdr, through its reverse tunnel (design.md "Client targets").
import { join } from 'node:path';
import type { HerdrClient, RemoteHerdr } from '../../../executors/herdr/index.ts';
import { claudeArgsFor, createHerdrClaudeExecutor, createHerdrCliClient } from '../../../executors/herdr/index.ts';
import { clientSocket } from '../../../executors/client.ts';
import { hopperSshAuth } from '../../../executors/ssh.ts';
import type { PluginDefinition } from '../../sdk.ts';

export interface HerdrClaudeOptions {
  bin: string;
  claudeBin: string;
  session: string;
  yolo: boolean;
  args: string[];
  cwd: string;
  trustWorkdir: boolean;
  pollMs: number;
  idleNudgeMs: number;
}

/**
 * The plugin. `seam` (tests, `UserSeams.herdr`) replaces the herdr CLI client; detection then
 * says available, since nothing is run. The session defaults to the supervised `hopper` for every
 * user; no user gets a session of its own (issue #261).
 */
export function herdrClaudePlugin(seam?: HerdrClient): PluginDefinition<'executor', HerdrClaudeOptions> {
  return {
    id: 'herdr-claude',
    role: 'executor',
    describe: 'Claude Code in a pane of hopper\'s own herdr session, one tab per job',
    options: (z) => z.object({
      bin: z.string().min(1).default('herdr').meta({ commandBearing: true, description: 'the herdr CLI' }),
      claudeBin: z.string().min(1).default('claude')
        .meta({ commandBearing: true, description: 'the claude CLI herdr starts (detection checks it is on PATH)' }),
      // Never the user's default herdr session (herdr's own doctrine; design.md "herdr session").
      session: z.string().min(1).refine((s) => s !== 'default', 'must not be the default herdr session').default('hopper'),
      yolo: z.boolean().default(true).meta({
        commandBearing: true,
        description: 'yolo: Claude runs with every permission granted (--dangerously-skip-permissions) and never stops to ask. Off: Claude asks before it acts, and each dialog goes to the job\'s answerers',
      }),
      args: z.array(z.string()).default([])
        .meta({ commandBearing: true, description: "Claude Code's other arguments: allowed tools, MCP config (yolo decides the permissions)" }),
      cwd: z.string().min(1).default('~')
        .meta({ commandBearing: true, description: 'working directory of a job whose payload names none' }),
      trustWorkdir: z.boolean().default(true),
      pollMs: z.number().int().positive().default(1000),
      idleNudgeMs: z.number().int().positive().default(20000),
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
      // One client per attached machine's herdr; their ssh connections share sockets under the data
      // dir (a unix socket path is capped at 108 bytes: keep the data dir short).
      const remotes = new Map<string, HerdrClient>();
      const remote = (there: RemoteHerdr): HerdrClient => {
        const key = JSON.stringify(there);
        let client = remotes.get(key);
        if (!client) {
          client = seam ?? ('client' in there
            ? createHerdrCliClient({
              client: { machine: there.client.machine, socket: clientSocket(ctx.dataDir, there.client.machine), token: () => ctx.env(there.client.tokenEnv) ?? '' },
            })
            : createHerdrCliClient({
              bin: there.bin, session: there.session,
              ssh: { target: there.ssh, controlDir: join(ctx.dataDir, 'ssh'), auth: () => hopperSshAuth({ env: ctx.env, dataDir: ctx.dataDir }) },
            }));
          remotes.set(key, client);
        }
        return client;
      };
      // This machine added with a herdr session of its own (issue #260): its jobs run in that session.
      const sessions = new Map<string, HerdrClient>();
      const local = (session: string): HerdrClient => {
        let client = sessions.get(session);
        if (!client) sessions.set(session, (client = seam ?? createHerdrCliClient({ bin: o.bin, session, userEnv: ctx.userEnv })));
        return client;
      };
      // A user's processes on this machine start with their CLI config dirs (issue #158): the herdr CLI
      // (which starts the session's server) and every pane, through its tab's environment.
      return createHerdrClaudeExecutor({
        herdr: seam ?? createHerdrCliClient({ bin: o.bin, session: o.session, userEnv: ctx.userEnv }), remote, local, paneEnv: ctx.userEnv,
        clock: ctx.clock, defaultCwd: o.cwd, claudeArgs: claudeArgsFor(o.yolo, o.args), trustWorkdir: o.trustWorkdir, yolo: o.yolo,
        pollMs: o.pollMs, idleNudgeMs: o.idleNudgeMs,
      });
    },
  };
}

export default herdrClaudePlugin();
