// `hopper-egress` (issue #2849, part 2; design.md "A job's egress allowlist"): the job's side of its egress allowlist. An
// HTTP proxy on 127.0.0.1 where the job runs: each CONNECT, and each plain HTTP request in absolute form, becomes one
// connection through the hopper (`GET /job/egress`, an HTTP/1.1 upgrade, src/http/job-egress.ts), which joins it to the
// host only when the job's allowlist holds it. With a command, the command runs with HTTPS_PROXY and HTTP_PROXY set to the
// proxy and NO_PROXY to the hopper and loopback, and the proxy ends with it: the job's sandbox runner starts the agent so
// when the user's setting routes jobs through the allowlist (`HOPPER_EGRESS_ROUTE`, src/client/job-sandbox.ts). Kept in
// the job's credentials dir beside its proxy token, as `hopper-relay` is: a POSIX sh line that runs the client, a Node
// module with no dependency. Its token goes in a header, never on a command line.

export const EGRESS_SCRIPT_VARIABLE = 'HOPPER_EGRESS';
/** Set in a job's environment when its user's setting routes its connections through the allowlist. */
export const EGRESS_ROUTE_VARIABLE = 'HOPPER_EGRESS_ROUTE';

/** The route on the hopper's URL a job's connection out goes to (src/http/job-egress.ts), and the upgrade's protocol. */
export const JOB_EGRESS_PATH = '/job/egress';
export const JOB_EGRESS_PROTOCOL = 'hopper-egress/1';

/** The files under the job's credentials dir. */
export const EGRESS_SCRIPT_FILE = 'hopper/egress';
export const EGRESS_CLIENT_FILE = 'hopper/egress.mjs';

/** The script: Node runs the client beside it. With no Node, a command runs as it is, its connections not routed. */
export const EGRESS_SCRIPT = `#!/bin/sh
# hopper-egress — this job's connections out through its egress allowlist (issue #2849). Written by the hopper at each job start.
#   sh "$HOPPER_EGRESS" [-- COMMAND [ARG...]]
# The client and its help: egress.mjs beside this file.
if ! command -v node >/dev/null 2>&1; then
  echo 'hopper-egress: it needs node on PATH: the connections are not routed through the allowlist' >&2
  [ "$1" = -- ] && [ $# -gt 1 ] && { shift; exec "$@"; }
  exit 2
fi
exec node "$(dirname "$0")/egress.mjs" "$@"
`;

/** The client: a Node module with no dependency. */
export const EGRESS_CLIENT = `// hopper-egress (issue #2849): an HTTP proxy on 127.0.0.1 here; each connection goes out through the hopper, to a host on
// this job's egress allowlist only.
//   sh "$HOPPER_EGRESS" [-- COMMAND [ARG...]]
//   COMMAND  run with HTTPS_PROXY and HTTP_PROXY set to the proxy (and their lowercase names), NO_PROXY to the hopper and
//            loopback, and HOPPER_EGRESS_PORT to its port; the proxy ends with it. Exit: COMMAND's own.
//            None: it says "hopper-egress: on 127.0.0.1:PORT" on stderr, and holds the port until it is stopped.
// A host off the allowlist gets the hopper's 403 and its reason; the hopper records the denial on the job.
// Exit 1: the port could not be held; 2: a bad call.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

const USAGE = 'usage: sh "$HOPPER_EGRESS" [-- COMMAND [ARG...]]';
const say = (line) => process.stderr.write(\`hopper-egress: \${line}\\n\`);
const args = process.argv.slice(2);
const command = args[0] === '--' ? args.slice(1) : [];
if (args.length > 0 && (args[0] !== '--' || command.length === 0)) { say(USAGE); process.exit(2); }
const base = process.env.HOPPER_URL;
const tokenFile = process.env.HOPPER_TOKEN_FILE;
if (!base) { say('HOPPER_URL is not set: the hopper cannot be reached from here'); process.exit(2); }
if (!tokenFile) { say('HOPPER_TOKEN_FILE is not set'); process.exit(2); }
const hopper = new URL(base);

/** One connection to host:port through the hopper: the upgraded socket, or the hopper's no and its status. */
function through(to) {
  return new Promise((resolve) => {
    const url = new URL('${JOB_EGRESS_PATH}', hopper);
    url.searchParams.set('to', to);
    const token = readFileSync(tokenFile, 'utf8').trim();
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', headers: { authorization: \`Bearer \${token}\`, connection: 'Upgrade', upgrade: '${JOB_EGRESS_PROTOCOL}' },
    });
    req.on('upgrade', (_res, socket, head) => { if (head.length) socket.unshift(head); resolve({ socket }); });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode ?? 502, no: body.trim() || \`no: the hopper answered \${res.statusCode}\` }));
    });
    req.on('error', (e) => resolve({ status: 502, no: \`no: the hopper cannot be reached: \${e.message}\` }));
    req.end();
  });
}

const plain = (status, text) => \`HTTP/1.1 \${status} \${status === 403 ? 'Forbidden' : 'Bad Gateway'}\\r\\ncontent-type: text/plain; charset=utf-8\\r\\ncontent-length: \${Buffer.byteLength(text) + 1}\\r\\nconnection: close\\r\\n\\r\\n\${text}\\n\`;

const server = createServer();
// CONNECT host:port: a tunnel, TLS and all.
server.on('connect', (req, conn, head) => {
  conn.on('error', () => undefined);
  void through(req.url ?? '').then((up) => {
    if ('no' in up) { conn.end(plain(up.status, up.no)); return; }
    conn.write('HTTP/1.1 200 Connection established\\r\\n\\r\\n');
    if (head.length) up.socket.write(head);
    conn.pipe(up.socket);
    up.socket.pipe(conn);
    up.socket.on('error', () => conn.destroy());
    conn.on('close', () => up.socket.destroy());
    up.socket.on('close', () => conn.destroy());
  });
});
// A plain HTTP request in absolute form (http://host/path): sent on a connection through the hopper, in origin form.
server.on('request', (req, res) => {
  let target;
  try { target = new URL(req.url ?? ''); } catch { target = undefined; }
  if (!target || target.protocol !== 'http:') { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('no: hopper-egress takes CONNECT, or a request to an http:// URL\\n'); return; }
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !k.startsWith('proxy-')));
  const up = httpRequest({
    method: req.method, path: target.pathname + target.search, headers,
    createConnection: (_o, done) => {
      void through(\`\${target.hostname}:\${target.port || 80}\`).then((r) => ('no' in r ? done(Object.assign(new Error(r.no), { status: r.status })) : done(null, r.socket)));
    },
  });
  up.on('response', (back) => { res.writeHead(back.statusCode ?? 502, back.headers); back.pipe(res); });
  up.on('error', (e) => { if (!res.headersSent) res.writeHead(e.status ?? 502, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' }); res.end(\`\${e.message}\\n\`); });
  req.pipe(up);
});
server.on('clientError', (_e, conn) => conn.destroy());
server.on('error', (e) => { say(\`cannot hold a port on 127.0.0.1: \${e.message}\`); process.exit(1); });
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  if (command.length === 0) {
    say(\`on 127.0.0.1:\${port}\`);
    for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
    return;
  }
  const proxy = \`http://127.0.0.1:\${port}\`;
  const near = [...new Set([...(process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(','), 'localhost', '127.0.0.1', '::1', hopper.hostname].map((h) => h.trim()).filter(Boolean))].join(',');
  const env = { ...process.env, HTTPS_PROXY: proxy, https_proxy: proxy, HTTP_PROXY: proxy, http_proxy: proxy, NO_PROXY: near, no_proxy: near, HOPPER_EGRESS_PORT: String(port) };
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env });
  // The command's own signals are its: the proxy passes them on and ends when the command does.
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
  child.on('error', (e) => { say(\`\${command[0]}: \${e.message}\`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
});
`;
