// hopper-sse-e2e driver: runs INSIDE a node:24 container on the throwaway podman network, from a hopper checkout
// mounted at /src (cwd). It boots the real composition root (src/main.ts via test/support/app.ts) against the
// throwaway Postgres, real OpenFGA (unless FGA=fake), and exposes:
//   :4799  the hopper itself (bound to :: with LAN peers = the podman network, so the sandbox's client can dial in)
//   :4797  a counting proxy for /job/* only (the job's HOPPER_URL): counts POST /job/skill and GET /job/stream calls
//   :4798  a tiny control API the host script (run.sh) drives: setup, job, give, restart, stream, events, calls, stop
// Nothing here prints a credential value. The value reaches the hopper only in POST /give's body, which is
// passed straight to the UI's vault API (/ui/api/vault give-credential) as a person's browser would.
//
// run.sh mounts this file at /src/e2e-driver.ts, so its imports are relative to the checkout root. That is why
// tsconfig.json and eslint.config.js leave this folder out: from its own path, the imports do not resolve.
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { startTestApp, type TestApp } from './test/support/app.ts';
import { waitFor } from './test/support/wait.ts';
import { proxyToken } from './src/github-proxy/token.ts';
import { SKILL_SCRIPT } from './src/skills/index.ts';

const PORT = 4799;
const DATA = process.env.E2E_DATA ?? '/data';
mkdirSync(DATA, { recursive: true });
const dbPath = join(DATA, 'db');
const TOKEN_KEY = process.env.E2E_TOKEN_KEY ?? randomBytes(32).toString('hex');
const FGA = process.env.FGA ?? 'real';
const PEERS = process.env.E2E_PEERS ?? '10.0.0.0/8';
const log = (m: string): void => { console.log(`[driver ${new Date().toISOString()}] ${m}`); };

let a: TestApp | undefined;
let session = '';
let job = '';
const calls: { at: string; method: string; path: string; lastEventId?: string; status?: number }[] = [];

async function boot(first: boolean): Promise<void> {
  const seams: Record<string, unknown> = {};
  if (FGA === 'fake') {
    const { createFakeAuthorizationServer } = await import('./test/support/fake-authorization-server.ts');
    seams.authorizationServer = createFakeAuthorizationServer();
  }
  a = await startTestApp({
    dbPath,
    env: {
      HOPPER_PORT: String(PORT), HOPPER_LAN_PEERS: PEERS, HOPPER_LAN_NAMES: 'hopper',
      ...(FGA === 'real' ? { HOPPER_OPENFGA_URL: process.env.E2E_OPENFGA_URL ?? 'http://openfga:8080' } : {}),
      HOPPER_TICK_MS: '200',
    },
    secrets: { HOPPER_TOKEN_KEY: TOKEN_KEY, ...(FGA === 'real' ? { HOPPER_OPENFGA_KEY: process.env.E2E_OPENFGA_KEY ?? '' } : {}) },
    plugins: first ? { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } } : false,
    seams,
  });
  session = await a.login();
  log(`hopper up at ${a.url} (fga=${FGA}, first=${first})`);
}

const vault = async (body: Record<string, unknown>): Promise<{ status: number; body: any }> => {
  const r = await a!.ui<any>('/ui/api/vault', body, { token: session });
  return { status: r.status, body: r.body };
};
const machines = async (): Promise<any[]> => (await a!.api('GET', '/api/machines')).body.machines as any[];
const online = (name: string): Promise<any> => waitFor(async () => (await machines()).find((m) => m.id === name && m.online), { timeoutMs: 60000, what: `${name} online` });

async function readBody(req: IncomingMessage): Promise<any> {
  let s = '';
  for await (const c of req) s += c;
  return s ? JSON.parse(s) : {};
}
const send = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const routes: Record<string, (b: any) => Promise<unknown>> = {
  // The template the sandbox joins as, approved here (throwaway only), and a join line for it.
  async 'POST /setup'(b) {
    const name = b.template ?? 'widgets-box';
    const saved = await vault({ action: 'save-template', name, image: b.image ?? 'ghcr.io/henningfutrell/hopper:box-claude-dev', secrets: [] });
    const approved = await vault({ action: 'approve-template', name });
    const code = (await a!.ui<{ code: string }>('/ui/api/machines/join', { template: name }, { token: session })).body.code;
    return { saved: saved.status, approved: approved.status, line: `http://hopper:${PORT}#${code}`, template: name };
  },
  // A job placed on the sandbox's lane (the scripted executor holds it at work), and what its pane would get.
  async 'POST /job'(b) {
    const m = await online(b.machine);
    const j = await a!.pull({ op: 'sleep', ms: 600_000 });
    const running = await a!.waitForStatus(j.id, 'running', 30000);
    job = j.id;
    const token = proxyToken(a!.user().store.settings.getLinkKey()!.privateKey, a!.user().user.id, j.id);
    return { job: j.id, lane: running.laneId, token, skill: SKILL_SCRIPT, helper: m.client?.vault ?? null, sse: SKILL_SCRIPT.includes('/job/stream') };
  },
  async 'GET /requests'() { return (await a!.api('GET', '/api/vault')).body.requests ?? []; },
  // The person: gives the credential the job asked for, through the UI's vault API.
  async 'POST /give'(b) {
    const r = await waitFor(async () => ((await a!.api('GET', '/api/vault')).body.requests ?? []).find((x: any) => x.skill === b.service), { timeoutMs: 60000, what: `request for ${b.service}` });
    const g = await vault({ action: 'give-credential', request: r.id, name: b.service, kind: 'asked', value: b.value });
    return { request: r.id, asked: r.asked, status: g.status, error: g.body?.error };
  },
  async 'POST /restart'(b) {
    log('restart: stopping hopper');
    await a!.stop();
    if (b.downMs) await new Promise((d) => setTimeout(d, b.downMs));
    await boot(false);
    await online(b.machine);
    const j = await a!.waitForStatus(job, 'running', 60000).catch((e: Error) => ({ error: e.message }));
    return { restarted: true, job: j };
  },
  async 'GET /events'() { return { events: await a!.events(), job: job ? await a!.job(job) : null }; },
  async 'GET /calls'() { return calls; },
  async 'GET /stream'(b) {
    const res = await fetch(`${a!.url}/job/stream?request=${b.request}`, { headers: { authorization: `Bearer ${b.token}`, 'last-event-id': '0' }, signal: AbortSignal.timeout(5000) }).catch((e: Error) => ({ status: 0, text: async () => e.message }));
    return { status: res.status, text: await res.text() };
  },
  async 'POST /stop'() { await a?.stop(); setTimeout(() => process.exit(0), 100); return { stopped: true }; },
};

createServer((req, res) => {
  const u = new URL(req.url!, 'http://x');
  const route = routes[`${req.method} ${u.pathname}`];
  if (!route) return send(res, 404, { error: 'no route' });
  readBody(req).then((b) => route({ ...Object.fromEntries(u.searchParams), ...b })).then((r) => send(res, 200, r), (e: Error) => { log(`control error: ${e.message}`); send(res, 500, { error: e.message }); });
}).listen(4798, '0.0.0.0');

// The job's HOPPER_URL: /job/* only (anything else is refused, so the sandbox gets no loopback powers through it).
createServer((req, res) => {
  const id = req.headers['last-event-id'];
  const entry = { at: new Date().toISOString(), method: req.method!, path: req.url!.split('?')[0]!, ...(typeof id === 'string' ? { lastEventId: id } : {}) } as (typeof calls)[number];
  calls.push(entry);
  if (!entry.path.startsWith('/job/')) { res.writeHead(403); res.end('only /job/*\n'); return; }
  const up = request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${PORT}` } }, (r) => {
    entry.status = r.statusCode;
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
    r.on('close', () => { if (!r.complete) res.destroy(); });
  });
  up.on('error', () => { entry.status = 0; res.destroy(); });
  req.pipe(up);
}).listen(4797, '0.0.0.0');

await boot(true);
log('control on :4798, job proxy on :4797');
