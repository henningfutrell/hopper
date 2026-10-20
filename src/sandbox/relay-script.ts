// `hopper-relay` (issue #2146, the bastion path, part 2; design.md "Bastions"): the command a job runs to reach one of its
// bastion's targets. It holds a port on 127.0.0.1 where the job runs, and joins each connection to it to the target
// through the hopper's relay (`GET /job/relay`, an HTTP/1.1 upgrade, src/http/job-relay.ts), so a job's own curl,
// promtool, logcli or psql reach a forward in the bastion's box as a local port. Kept in the job's credentials dir beside
// its proxy token and `hopper-skill`, run as `sh "$HOPPER_RELAY"`: a POSIX sh line that runs the client, a Node module
// with no dependency (curl cannot hold a two-way byte stream). Its token goes in a header, never on a command line.

export const RELAY_SCRIPT_VARIABLE = 'HOPPER_RELAY';

/** The route on the hopper's URL a job's relay connection goes to. */
export const RELAY_PATH = '/job/relay';
/** The upgrade's protocol. */
export const RELAY_PROTOCOL = 'hopper-relay/1';

/** The files under the job's credentials dir. */
export const RELAY_SCRIPT_FILE = 'hopper/relay';
export const RELAY_CLIENT_FILE = 'hopper/relay.mjs';

/** The script: Node runs the client beside it. */
export const RELAY_SCRIPT = `#!/bin/sh
# hopper-relay — a local port joined to a target of this job's bastion (issue #2146). Written by the hopper at each job start.
#   sh "$HOPPER_RELAY" TARGET [LOCAL] [-- COMMAND [ARG...]]
# The client and its help: relay.mjs beside this file.
command -v node >/dev/null 2>&1 || { echo 'hopper-relay: it needs node on PATH' >&2; exit 2; }
exec node "$(dirname "$0")/relay.mjs" "$@"
`;

/** The client: a Node module with no dependency. */
export const RELAY_CLIENT = `// hopper-relay (issue #2146): a port on 127.0.0.1 here, joined to a target of this job's bastion through the hopper.
//   sh "$HOPPER_RELAY" TARGET [LOCAL] [-- COMMAND [ARG...]]
//   TARGET   as the bastion names it: <cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>
//   LOCAL    the port on 127.0.0.1 here; none: one the system picks
//   COMMAND  run while the port is open, with HOPPER_RELAY_PORT set to it; then the port closes. Exit: COMMAND's own.
//            None: the port stays open until the relay is stopped (Ctrl-C, kill).
// It says "hopper-relay: TARGET on 127.0.0.1:PORT" on stderr once the hopper took a first connection.
// Exit 1: the hopper refused it (its reason on stderr); 2: a bad call.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';

const USAGE = 'usage: sh "$HOPPER_RELAY" TARGET [LOCAL] [-- COMMAND [ARG...]]';
const say = (line) => process.stderr.write(\`hopper-relay: \${line}\\n\`);
const args = process.argv.slice(2);
const dash = args.indexOf('--');
const own = dash < 0 ? args : args.slice(0, dash);
const command = dash < 0 ? [] : args.slice(dash + 1);
if (own.length < 1 || own.length > 2 || (dash >= 0 && command.length === 0) || own[0].startsWith('-')) { say(USAGE); process.exit(2); }
const [target, localText] = own;
const local = localText === undefined ? 0 : Number(localText);
if (!Number.isInteger(local) || local < 0 || local > 65535) { say(\`\${localText} is no port: 1 to 65535\`); process.exit(2); }
const base = process.env.HOPPER_URL;
const tokenFile = process.env.HOPPER_TOKEN_FILE;
if (!base) { say('HOPPER_URL is not set: the hopper cannot be reached from here'); process.exit(2); }
if (!tokenFile) { say('HOPPER_TOKEN_FILE is not set'); process.exit(2); }
const url = new URL('${RELAY_PATH}', base);
url.searchParams.set('target', target);

/** One connection to the target through the hopper: the upgraded socket, or the hopper's no. */
function connect() {
  return new Promise((resolve) => {
    const token = readFileSync(tokenFile, 'utf8').trim();
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers: { authorization: \`Bearer \${token}\`, connection: 'Upgrade', upgrade: '${RELAY_PROTOCOL}' },
    });
    req.on('upgrade', (_res, socket, head) => resolve({ socket, head }));
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ no: body.trim() || \`the hopper answered \${res.statusCode}\` }));
    });
    req.on('error', (e) => resolve({ no: \`the hopper cannot be reached: \${e.message}\` }));
    req.end();
  });
}

function join(conn, up) {
  if (up.head.length) conn.write(up.head);
  conn.pipe(up.socket);
  up.socket.pipe(conn);
  conn.on('error', () => up.socket.destroy());
  up.socket.on('error', () => conn.destroy());
  conn.on('close', () => up.socket.destroy());
  up.socket.on('close', () => { if (!conn.writableEnded) conn.end(); });
}

// The first connection says whether the hopper takes the target: a no ends the relay before anything uses the port.
const first = await connect();
if ('no' in first) { say(first.no.replace(/^no: /, '')); process.exit(1); }
first.socket.destroy();

const server = createServer({ allowHalfOpen: true }, (conn) => {
  conn.pause();
  void connect().then((up) => {
    if ('no' in up) { say(up.no.replace(/^no: /, '')); conn.destroy(); return; }
    join(conn, up);
    conn.resume();
  });
});
server.on('error', (e) => { say(\`cannot hold 127.0.0.1:\${local}: \${e.message}\`); process.exit(1); });
server.listen(local, '127.0.0.1', () => {
  const port = server.address().port;
  say(\`\${target} on 127.0.0.1:\${port}\`);
  if (command.length === 0) {
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
    return;
  }
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, HOPPER_RELAY_PORT: String(port) } });
  child.on('error', (e) => { say(\`\${command[0]}: \${e.message}\`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
});
`;
