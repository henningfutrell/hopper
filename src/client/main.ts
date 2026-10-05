// The hopper client's entry (design.md "Client targets", issue #59): `node main.ts`, run by the
// job-hopper-client unit on a client target. Process settings from its environment:
//   JOB_HOPPER_CLIENT_TOKEN_FILE   the client's token (a file only this user may read), shared with the hopper
//   JOB_HOPPER_CLIENT_HERDR_BIN    this machine's herdr (absolute)
//   JOB_HOPPER_CLIENT_SESSION      the herdr session the hopper's jobs run in (never `default`)
//   JOB_HOPPER_CLIENT_HOPPER       the hopper's machine, user@host; JOB_HOPPER_CLIENT_HOPPER_PORT (default 22)
//   JOB_HOPPER_CLIENT_KEY_FILE     this client's ssh key; JOB_HOPPER_CLIENT_KNOWN_HOSTS the hopper's pinned host key
// The client's install dir is this file's directory: the hopper loads its release there (release.ts,
// issue #70), and the client exits 75 so its unit (Restart=always) starts the new files.
import { lstatSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClient } from './server.ts';
import { dialHopper } from './tunnel.ts';

function setting(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function ownerOnly(file: string): string {
  if ((lstatSync(file).mode & 0o077) !== 0) throw new Error(`${file} is readable by others; make it 600`);
  return file;
}

const tokenFile = ownerOnly(setting('JOB_HOPPER_CLIENT_TOKEN_FILE'));
const client = startClient({
  token: () => readFileSync(tokenFile, 'utf8').trim(),
  herdrBin: setting('JOB_HOPPER_CLIENT_HERDR_BIN'),
  session: setting('JOB_HOPPER_CLIENT_SESSION'),
  tunnel: dialHopper({
    hopper: setting('JOB_HOPPER_CLIENT_HOPPER'),
    port: Number(process.env.JOB_HOPPER_CLIENT_HOPPER_PORT ?? 22),
    keyFile: ownerOnly(setting('JOB_HOPPER_CLIENT_KEY_FILE')),
    knownHostsFile: setting('JOB_HOPPER_CLIENT_KNOWN_HOSTS'),
  }),
  log: (line) => process.stdout.write(`${line}\n`),
  installDir: dirname(fileURLToPath(import.meta.url)),
  onLoaded: () => { void client.stop().then(() => process.exit(75)); },
});
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { void client.stop().then(() => process.exit(0)); });
