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
/** Set beside it when the setting also confines the job (part 4): the sandbox runner gives the agent a network namespace of its own. */
export const EGRESS_CONFINE_VARIABLE = 'HOPPER_EGRESS_CONFINE';

/** A job's variables for its user's setting: none unless it routes the job; confined only when routed. */
export const egressVars = (s: { route: boolean; confine: boolean }): Record<string, string> =>
  (s.route ? { [EGRESS_ROUTE_VARIABLE]: '1', ...(s.confine ? { [EGRESS_CONFINE_VARIABLE]: '1' } : {}) } : {});

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
//            loopback, NODE_USE_ENV_PROXY to 1 and HOPPER_EGRESS_PORT to its port; the proxy ends with it. Exit: COMMAND's own.
//            None: it says "hopper-egress: on 127.0.0.1:PORT" on stderr, and holds the port until it is stopped.
//   sh "$HOPPER_EGRESS" --socket PATH [-- COMMAND [ARG...]]
//            The same proxy on the Unix socket PATH, not on a port, and COMMAND run as it is: the job's sandbox runner runs
//            bubblewrap so, with a network namespace of its own (part 4), whose one way out is this socket.
//   sh "$HOPPER_EGRESS" --from PATH -- COMMAND [ARG...]
//            Inside that namespace: a port on 127.0.0.1 that joins each connection to the proxy at PATH, and COMMAND run
//            with the proxy variables set to that port. When the hopper's URL is on loopback, the same address and port
//            here go to the hopper too, so HOPPER_URL works as it is. Nothing here needs the job's token.
// The hopper itself is reached directly, never through the allowlist: a job reaches the hopper at HOPPER_URL.
// A host off the allowlist gets the hopper's 403 and its reason; the hopper records the denial on the job.
// Exit 1: the port or the socket could not be held; 2: a bad call.
import { spawn } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect, createServer as createNetServer } from 'node:net';

const USAGE = 'usage: sh "$HOPPER_EGRESS" [--socket PATH | --from PATH] [-- COMMAND [ARG...]]';
const say = (line) => process.stderr.write(\`hopper-egress: \${line}\\n\`);
const args = process.argv.slice(2);
const mode = args[0] === '--socket' || args[0] === '--from' ? args[0].slice(2) : 'port';
const socketPath = mode === 'port' ? undefined : args[1];
if (mode !== 'port') args.splice(0, 2);
const command = args[0] === '--' ? args.slice(1) : [];
if ((mode !== 'port' && !socketPath) || (args.length > 0 && (args[0] !== '--' || command.length === 0)) || (mode === 'from' && command.length === 0)) { say(USAGE); process.exit(2); }
const base = process.env.HOPPER_URL;
const tokenFile = process.env.HOPPER_TOKEN_FILE;
if (!base) { say('HOPPER_URL is not set: the hopper cannot be reached from here'); process.exit(2); }
if (!tokenFile && mode !== 'from') { say('HOPPER_TOKEN_FILE is not set'); process.exit(2); }
const hopper = new URL(base);
const hopperHost = hopper.hostname.replace(/^\\[|\\]$/g, '').toLowerCase();
const hopperPort = Number(hopper.port || (hopper.protocol === 'https:' ? 443 : 80));
const hopperTo = \`\${hopper.hostname}:\${hopperPort}\`;
const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

/** Whether host:port is the hopper itself. */
function isHopper(to) {
  const at = to.lastIndexOf(':');
  return to.slice(0, at).replace(/^\\[|\\]$/g, '').toLowerCase() === hopperHost && Number(to.slice(at + 1)) === hopperPort;
}

/** Two sockets joined, each closed with the other. */
function join(a, b) {
  a.on('error', () => b.destroy());
  b.on('error', () => a.destroy());
  a.on('close', () => b.destroy());
  b.on('close', () => a.destroy());
  a.pipe(b);
  b.pipe(a);
}

/** One connection to host:port through the hopper (the hopper itself directly): the socket, or the hopper's no and its status. */
function through(to) {
  if (isHopper(to)) {
    return new Promise((resolve) => {
      const socket = netConnect(hopperPort, hopperHost);
      socket.once('connect', () => resolve({ socket }));
      socket.once('error', (e) => resolve({ status: 502, no: \`no: the hopper cannot be reached: \${e.message}\` }));
    });
  }
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

/** The proxy: CONNECT, and plain HTTP requests in absolute form. */
function proxy() {
  const server = createServer();
  // CONNECT host:port: a tunnel, TLS and all.
  server.on('connect', (req, conn, head) => {
    conn.on('error', () => undefined);
    void through(req.url ?? '').then((up) => {
      if ('no' in up) { conn.end(plain(up.status, up.no)); return; }
      conn.write('HTTP/1.1 200 Connection established\\r\\n\\r\\n');
      if (head.length) up.socket.write(head);
      join(conn, up.socket);
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
  return server;
}

/** Run the command with \`more\` in its environment; exit with it. Its own signals are its: passed on. */
function run(more) {
  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: { ...process.env, ...more } });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => child.kill(s));
  child.on('error', (e) => { say(\`\${command[0]}: \${e.message}\`); process.exit(127); });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + 15 : 1)));
}

/** The proxy variables for a proxy on 127.0.0.1:port; \`near\` goes direct. */
function proxyEnv(port, near) {
  const at = \`http://127.0.0.1:\${port}\`;
  const no = [...new Set([...(process.env.NO_PROXY ?? process.env.no_proxy ?? '').split(','), ...near].map((h) => h.trim()).filter(Boolean))].join(',');
  return { HTTPS_PROXY: at, https_proxy: at, HTTP_PROXY: at, http_proxy: at, NO_PROXY: no, no_proxy: no, NODE_USE_ENV_PROXY: '1', HOPPER_EGRESS_PORT: String(port) };
}

const hold = (what) => (e) => { say(\`cannot hold \${what}: \${e.message}\`); process.exit(1); };

if (mode === 'port') {
  const server = proxy();
  server.on('error', hold('a port on 127.0.0.1'));
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    if (command.length === 0) {
      say(\`on 127.0.0.1:\${port}\`);
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
      return;
    }
    run(proxyEnv(port, [...LOOPBACK, hopper.hostname]));
  });
} else if (mode === 'socket') {
  const server = proxy();
  server.on('error', hold(\`the socket \${socketPath}\`));
  rmSync(socketPath, { force: true });
  process.on('exit', () => rmSync(socketPath, { force: true }));
  server.listen(socketPath, () => {
    if (command.length === 0) {
      say(\`on \${socketPath}\`);
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));
      return;
    }
    run({});
  });
} else {
  // Inside the job's own network namespace: each connection to the port goes to the proxy's socket as it is.
  const relay = createNetServer((conn) => join(conn, netConnect(socketPath)));
  relay.on('error', hold('a port on 127.0.0.1'));
  // The hopper on loopback: the same address and port here, each connection a CONNECT to it through the proxy's socket.
  const toHopper = (conn) => {
    conn.on('error', () => undefined);
    const up = netConnect(socketPath);
    up.on('error', () => conn.destroy());
    up.write(\`CONNECT \${hopperTo} HTTP/1.1\\r\\nhost: \${hopperTo}\\r\\n\\r\\n\`);
    let head = Buffer.alloc(0);
    const answer = (d) => {
      head = Buffer.concat([head, d]);
      const end = head.indexOf('\\r\\n\\r\\n');
      if (end < 0) return;
      up.off('data', answer);
      if (head.toString('latin1').split('\\r\\n')[0].split(' ')[1] !== '200') { conn.destroy(); up.destroy(); return; }
      const rest = head.subarray(end + 4);
      if (rest.length) conn.write(rest);
      join(conn, up);
    };
    up.on('data', answer);
  };
  const addresses = !LOOPBACK.includes(hopperHost) ? [] : hopperHost === 'localhost' ? ['127.0.0.1', '::1'] : [hopperHost];
  const listening = addresses.map((a) => new Promise((ok) => {
    const s = createNetServer(toHopper);
    s.on('error', (e) => { if (a === '127.0.0.1' || hopperHost !== 'localhost') say(\`the hopper at \${a}:\${hopperPort} cannot be reached from here: \${e.message}\`); ok(); });
    s.listen(hopperPort, a, ok);
  }));
  relay.listen(0, '127.0.0.1', () => {
    void Promise.all(listening).then(() => run(proxyEnv(relay.address().port, LOOPBACK.includes(hopperHost) ? [...LOOPBACK, hopper.hostname] : LOOPBACK)));
  });
}
`;
