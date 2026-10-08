// The hopper client's entry (design.md "Client targets", "Joining a machine", issues #59, #308):
//   node main.ts join <hopper URL>#<join code> [name]   join a hopper (join.ts), then exit
//   node main.ts                                        dial in and serve, as the hopper-client unit or a box runs it
// Process settings from its environment:
//   HOPPER_CLIENT_DIR      its client dir: its link key and its link (default ~/.config/hopper-client)
//   HOPPER_CLIENT_SESSION  the herdr session the hopper's jobs run in (default hopper-client; never `default`)
//   HOPPER_JOIN            a join line: a machine that has not joined yet joins with it first (a sandbox box)
//   HOPPER_CLIENT_NAME     the name it joins under (default its host name)
// herdr and claude (a usage read, issue #366; a level's run, issue #482) are the ones on its PATH: the client is one long-lived process,
// never a fresh login shell per call.
// The client's install dir is this file's directory: the hopper loads its release there (release.ts,
// issue #70), and the client exits 75 so whatever runs it (the unit, a box's entrypoint) starts the new files.
import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dialIn } from './dial.ts';
import { hasLink, joinHopper, linkKeyFile, readLink } from './join.ts';
import { linkToken } from './link.ts';
import { startClient, type Client, type ClientOptions } from './server.ts';

/** A machine's name as the hopper takes it: letters, digits, `_` and `-`. */
export const machineName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^[-_]+|-+$/g, '') || 'machine';

/** The client of a joined machine: its link from its client dir, its token derived from its link key and the hopper's public half. */
export function startLinkedClient(o: { dir: string } & Pick<ClientOptions, 'herdrBin' | 'claudeBin' | 'session' | 'installDir' | 'backoffMs' | 'log' | 'onLoaded'>): Client {
  const link = readLink(o.dir);
  const token = linkToken(readFileSync(linkKeyFile(o.dir), 'utf8'), link.hopperKey);
  const { dir: _dir, ...rest } = o;
  return startClient({ ...rest, token: () => token, dial: dialIn({ url: link.url, user: link.user, key: link.key, token: () => token }) });
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
  if (!hasLink(dir) && process.env.HOPPER_JOIN) {
    const link = await joinHopper({ line: process.env.HOPPER_JOIN, name, dir });
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
