// The hopper client's entry (design.md "Client targets", "Joining a machine", issues #59, #308):
//   node main.ts join <hopper URL>#<join code> [name]   join a hopper (join.ts), then exit
//   node main.ts                                        dial in and serve, as the hopper-client unit or a box runs it
// Process settings from its environment:
//   HOPPER_CLIENT_DIR      its client dir: its link key and its link (default ~/.config/hopper-client)
//   HOPPER_CLIENT_SESSION  the herdr session the hopper's jobs run in (default hopper-client; never `default`)
//   HOPPER_JOIN_FILE       a file holding a join line (a sandbox box, issue #606): a machine that has not joined yet
//                          joins with it first. Read and removed at start, joined or not, so nothing keeps the code
//   HOPPER_CLIENT_NAME     the name it joins under (default its host name)
// herdr and claude (a usage read, issue #366; a level's run, issue #482) are the ones on its PATH: the client is one long-lived process,
// never a fresh login shell per call.
// The client's install dir is this file's directory: the hopper loads its release there (release.ts,
// issue #70), and the client exits 75 so whatever runs it (the unit, a box's entrypoint) starts the new files.
import { readFileSync, rmSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialIn } from './dial.ts';
import { hasLink, joinHopper, linkKeyFile, readLink } from './join.ts';
import { linkToken } from './link.ts';
import { startClient, type Client, type ClientOptions } from './server.ts';
import { askHopper, HELPER_FILE, startVault } from './vault.ts';

/** A machine's name as the hopper takes it: letters, digits, `_` and `-`. */
export const machineName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '') || 'machine';

/**
 * The client of a joined machine: its link from its client dir, its token derived from its link key and the hopper's
 * public half; and its vault (vault.ts, issue #558), the socket and helper a job gets a vault secret through.
 */
export function startLinkedClient(o: { dir: string } & Pick<ClientOptions, 'herdrBin' | 'claudeBin' | 'session' | 'installDir' | 'backoffMs' | 'log' | 'onLoaded'>): Client {
  const link = readLink(o.dir);
  const token = linkToken(readFileSync(linkKeyFile(o.dir), 'utf8'), link.hopperKey);
  const { dir, ...rest } = o;
  const vault = startVault({ dir, installDir: o.installDir, ask: askHopper({ url: link.url, user: link.user, key: link.key, token: () => token }), ...(o.log ? { log: o.log } : {}) });
  vault.catch((e: unknown) => o.log?.(`hopper-client: the vault's socket could not be served: ${(e as Error).message}`));
  const client = startClient({ ...rest, vaultHelper: join(dir, HELPER_FILE), token: () => token, dial: dialIn({ url: link.url, user: link.user, key: link.key, token: () => token }) });
  return {
    async stop() {
      await client.stop();
      await vault.then((v) => v.stop(), () => undefined);
    },
  };
}

/**
 * The join line a box was started with (issue #606): read from HOPPER_JOIN_FILE, the file removed and the
 * variable taken out of `env`, before anything starts — no process the client starts, and no later restart,
 * finds the code. The line comes through a file because a process's own environment stays readable in
 * /proc/<pid>/environ after it unsets a variable.
 */
export function takeJoinLine(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.HOPPER_JOIN_FILE;
  delete env.HOPPER_JOIN_FILE;
  if (!file) return undefined;
  let line: string;
  try { line = readFileSync(file, 'utf8').trim(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
  rmSync(file, { force: true });
  return line || undefined;
}

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

async function run(argv: string[]): Promise<void> {
  const dir = process.env.HOPPER_CLIENT_DIR || join(homedir(), '.config', 'hopper-client');
  const name = machineName(process.env.HOPPER_CLIENT_NAME || hostname());
  if (argv[0] === 'join') {
    if (!argv[1]) throw new Error('usage: main.ts join <hopper URL>#<join code> [name]');
    const link = await joinHopper({ line: argv[1], name: machineName(argv[2] ?? name), dir });
    say(`hopper-client: joined ${link.url} as ${link.machine}`);
    return;
  }
  if (argv.length) throw new Error(`unknown command ${argv[0]}: main.ts join <hopper URL>#<join code> [name], or no command to serve`);
  const line = takeJoinLine();
  if (!hasLink(dir) && line) {
    const link = await joinHopper({ line, name, dir });
    say(`hopper-client: joined ${link.url} as ${link.machine}`);
  }
  const client = startLinkedClient({
    dir, herdrBin: 'herdr', session: process.env.HOPPER_CLIENT_SESSION || 'hopper-client',
    installDir: dirname(fileURLToPath(import.meta.url)), log: say,
    onLoaded: () => { void client.stop().then(() => process.exit(75)); },
  });
  for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void client.stop().then(() => process.exit(0)); });
}

if (import.meta.main) {
  run(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`hopper-client: ${(e as Error).message}\n`);
    process.exit(1);
  });
}
