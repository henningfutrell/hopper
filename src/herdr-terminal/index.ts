// One user's herdr terminal (issue #189, design.md "The herdr terminal"). Opening it starts a client
// of the root herdr — `herdr --session <root>` on a pseudo-terminal, which starts that session's
// server the first time — and, alongside, brings the root herdr's saved machines to the plan, so its
// sidebar lists the herdr of every attached machine the hopper reaches over ssh. The client ends with
// the page; the root herdr server, its panes and its connections keep running.
//
// Everything the root herdr reaches a machine with is written under `<user work dir>/herdr-terminal/`
// on every open: `state/` (XDG_STATE_HOME: herdr's saved machines live there, the terminal's own),
// `bin/ssh` (the wrapper: the hopper's key, the pins, the hardened options), `known_hosts` (the pins).
import { accessSync, chmodSync, constants, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { HerdrTerminal, SpawnTerminal, SyncHerdrMachines } from '../domain/ports.ts';
import type { AttachedMachine, HerdrMachineSync, HerdrTerminalStatus } from '../domain/types.ts';
import { machineEnv } from '../executors/env.ts';
import type { SshAuth } from '../executors/ssh.ts';
import { herdrTerminalPlan, knownHostsLines, rootSession, sshWrapper, type Destination } from './plan.ts';

export interface HerdrTerminalOptions {
  /** The user's herdr session; the root herdr session is `<it>-root`. */
  session: string;
  /** The user work dir. */
  dataDir: string;
  /** The attached machines, as plugins.yaml says now. */
  machines: () => AttachedMachine[];
  /** The hopper's ssh key and pins (throws when it has no key). */
  sshAuth: () => SshAuth;
  /** An ssh target's destination, as the user's ssh config resolves it (throws on a jump host or a proxy). */
  resolve: (target: string) => Destination;
  /** The daemon's environment (the terminal keeps only the machine's variables of it) and the user's own. */
  env: Record<string, string | undefined>;
  userEnv: Record<string, string>;
  spawn: SpawnTerminal;
  sync: SyncHerdrMachines;
  /** herdr; default `herdr` on PATH. */
  herdr?: string;
  /** The real ssh, absolute; default the first `ssh` on PATH. */
  ssh?: () => string;
  logger: { warn(line: string): void };
}

function writeAtomic(file: string, text: string, mode: number): void {
  writeFileSync(`${file}.tmp`, text, { mode });
  chmodSync(`${file}.tmp`, mode);
  renameSync(`${file}.tmp`, file);
}

export function createHerdrTerminal(o: HerdrTerminalOptions): HerdrTerminal {
  const session = rootSession(o.session);
  const dir = join(o.dataDir, 'herdr-terminal');
  const herdr = o.herdr ?? 'herdr';
  let synced = new Map<string, HerdrMachineSync>();
  // One sync at a time: two pages opening at once must not both add the same machine.
  let syncing: Promise<void> = Promise.resolve();

  const plan = () => {
    try {
      const auth = o.sshAuth();
      return { auth, ...herdrTerminalPlan(o.machines(), o.resolve) };
    } catch (e) {
      return { problem: (e as Error).message, ...herdrTerminalPlan([], o.resolve), all: o.machines() };
    }
  };

  const env = (): Record<string, string> => {
    // The machine's variables, and where herdr's config and sessions are (the root herdr beside the user's herdr session).
    const kept = { ...machineEnv(o.env), ...(o.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: o.env.XDG_CONFIG_HOME } : {}) };
    const base = Object.fromEntries(Object.entries(kept).filter((e): e is [string, string] => e[1] !== undefined));
    return {
      ...base, ...o.userEnv,
      PATH: [join(dir, 'bin'), base.PATH ?? ''].join(delimiter),
      XDG_STATE_HOME: join(dir, 'state'),
      TERM: 'xterm-256color', COLORTERM: 'truecolor',
    };
  };

  return {
    status(): HerdrTerminalStatus {
      const p = plan();
      if ('problem' in p) {
        return { session, problem: p.problem, machines: p.all.map((m) => ({ name: m.name, label: m.label ?? m.name, listed: false, reason: p.problem })) };
      }
      return {
        session,
        machines: p.machines.map((m) => {
          const s = synced.get(m.name);
          return !m.listed || !s ? m : { ...m, sync: s.state, ...(s.error ? { error: s.error } : {}) };
        }),
      };
    },
    open({ cols, rows }) {
      mkdirSync(join(dir, 'bin'), { recursive: true, mode: 0o700 });
      mkdirSync(join(dir, 'state'), { recursive: true, mode: 0o700 });
      const e = env();
      const p = plan();
      if ('auth' in p) {
        const knownHostsFile = join(dir, 'known_hosts');
        writeAtomic(knownHostsFile, knownHostsLines(p.profiles), 0o600);
        writeAtomic(join(dir, 'bin', 'ssh'), sshWrapper({ ssh: o.ssh?.() ?? realSsh(e.PATH ?? '', dir), identityFile: p.auth.identityFile, knownHostsFile }), 0o700);
        syncing = syncing.then(() => o.sync({ herdr, env: e, profiles: p.profiles })).then((r) => {
          synced = new Map(r.map((x) => [x.machine, x]));
          for (const x of r) if (x.state === 'failed') o.logger.warn(`hopper: herdr terminal: the root herdr could not save machine ${x.machine}: ${x.error}`);
        }, (err: unknown) => o.logger.warn(`hopper: herdr terminal: saved machines not synced: ${(err as Error).message}`));
      } else {
        o.logger.warn(`hopper: herdr terminal: the root herdr reaches no machine: ${p.problem}`);
      }
      return o.spawn({ file: herdr, args: ['--session', session], env: e, cwd: o.env.HOME ?? dir, cols, rows });
    },
  };
}

/** The first `ssh` on PATH that is not the wrapper. */
function realSsh(path: string, dir: string): string {
  const wrapperDir = join(dir, 'bin');
  for (const d of path.split(delimiter)) {
    if (!d || d === wrapperDir) continue;
    const f = join(d, 'ssh');
    try {
      accessSync(f, constants.X_OK);
      return f;
    } catch { /* next */ }
  }
  return '/usr/bin/ssh';
}
