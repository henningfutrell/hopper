// The hopper's end of a client target's tunnel (design.md "Client targets", issue #59): the forced
// command of the client's tunnel key in this machine's authorized_keys —
//   restrict,command="node <app>/src/client/relay.ts <dataDir>/clients/<machine>.sock" <key>
// — so the key can do nothing else: no shell, no forwarding of any kind. It listens on that socket
// (only this user may open it), takes the hopper daemon's one connection, and pipes it to the ssh
// session's stdin and stdout, where the hopper client serves HTTP/2. When either side ends it exits,
// and the client dials again. Imports nothing of job-hopper.
import { chmodSync, lstatSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';

const socket = process.argv[2];
if (!socket || !socket.startsWith('/') || !socket.endsWith('.sock')) {
  process.stderr.write('usage: relay.ts <absolute path>.sock\n');
  process.exit(2);
}

// A socket left by a tunnel that died blocks the listen: only ever a socket is removed.
try { if (lstatSync(socket).isSocket()) rmSync(socket); } catch { /* none */ }

/** Written first: the client skips whatever the login shell printed before it (relay.ts runs through the user's shell). */
const RELAY_MARKER = 'JOB-HOPPER-RELAY/1\n';

const done = (): never => process.exit(0);
process.stdout.write(RELAY_MARKER);
const server = createServer((conn) => {
  // One connection per tunnel: no one else may reach the client through it.
  server.close();
  conn.pipe(process.stdout);
  process.stdin.pipe(conn);
  conn.on('close', done);
  conn.on('error', done);
});
server.maxConnections = 1;
server.on('error', (e) => { process.stderr.write(`relay: ${e.message}\n`); process.exit(1); });
server.listen(socket, () => chmodSync(socket, 0o600));
// The client went away (before or after the daemon connected).
process.stdin.on('end', done);
process.stdin.on('close', done);
