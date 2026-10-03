// Manifest-flow helper: docs/design.md "The manifest-flow helper". Node built-ins only.
// Exit codes: 0 created, 1 failure/timeout, 2 refused (config exists, no --force).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    name: { type: 'string' }, owner: { type: 'string' }, org: { type: 'string' },
    'no-webhook': { type: 'boolean' }, force: { type: 'boolean' }, 'no-open': { type: 'boolean' },
  },
});

const web = (process.env.JOB_HOPPER_GITHUB_WEB ?? 'https://github.com').replace(/\/$/, '');
const api = (process.env.JOB_HOPPER_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
const dir = process.env.JOB_HOPPER_CONFIG_DIR ?? join(homedir(), '.config', 'job-hopper');
const timeoutMs = Number(process.env.JOB_HOPPER_APP_FLOW_TIMEOUT_MS ?? 15 * 60 * 1000);
const target = (f: string) => join(dir, f);

const fail = (msg: string, code = 1): never => {
  process.stderr.write(`create-github-app: ${msg}\n`);
  return process.exit(code);
};

function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

function resolveOwner(): string {
  const given = opt.owner ?? process.env.JOB_HOPPER_OWNER;
  if (given) return given;
  try {
    const login = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' }).trim();
    if (login) return login;
  } catch { /* fall through */ }
  return fail('cannot tell the owner: pass --owner <login> (or set JOB_HOPPER_OWNER)');
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildManifest(owner: string, port: number): Record<string, unknown> {
  return {
    name: (opt.name ?? `job-hopper-${owner}`).slice(0, 34),
    url: `https://github.com/${owner}`,
    description: "Pulls jobs for job-hopper on the owner's laptop from issues labelled hopper.",
    ...(opt['no-webhook'] ? {} : { hook_attributes: { url: 'https://example.invalid/job-hopper-webhook', active: false } }),
    redirect_url: `http://127.0.0.1:${port}/callback`,
    public: false,
    default_permissions: { issues: 'write', metadata: 'read', organization_projects: 'read' },
    default_events: [],
  };
}

type Conversion = { id: number; slug: string; client_id: string; webhook_secret: string | null; pem: string; html_url: string; owner: { login: string } };

async function convert(code: string): Promise<Conversion> {
  const res = await fetch(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST', headers: { accept: 'application/vnd.github+json', 'user-agent': 'job-hopper-create-github-app' },
  });
  if (!res.ok) throw new Error(`conversion failed: HTTP ${res.status}`);
  const c = (await res.json()) as Conversion;
  if (!c.slug || !c.pem || !c.id) throw new Error('conversion response lacks id, slug or pem');
  return c;
}

// Writes the config files. All targets are checked for symlinks first; each file is
// created 600 under a temp name and renamed into place.
function writeConfig(c: Conversion): string {
  const names = ['github-app.pem', 'github-app-webhook.secret', 'github-app.json'];
  for (const n of names) {
    if (exists(target(n)) && lstatSync(target(n)).isSymbolicLink()) throw new Error(`refusing symlink at ${target(n)}`);
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmps: string[] = [];
  const put = (name: string, data: string) => {
    const tmp = `${target(name)}.tmp-${process.pid}`;
    tmps.push(tmp);
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeSync(fd, data); } finally { closeSync(fd); }
    chmodSync(tmp, 0o600);
    renameSync(tmp, target(name));
  };
  try {
    put('github-app.pem', c.pem);
    if (c.webhook_secret) put('github-app-webhook.secret', `${c.webhook_secret}\n`);
    else if (exists(target('github-app-webhook.secret'))) unlinkSync(target('github-app-webhook.secret'));
    put('github-app.json', `${JSON.stringify({
      version: 1, appId: c.id, slug: c.slug, botLogin: `${c.slug}[bot]`, clientId: c.client_id,
      htmlUrl: c.html_url, owner: c.owner.login, privateKeyFile: target('github-app.pem'),
      webhookSecretFile: c.webhook_secret ? target('github-app-webhook.secret') : null,
      createdAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch (e) {
    for (const t of tmps) { try { unlinkSync(t); } catch { /* already renamed */ } }
    throw e;
  }
  return target('github-app.json');
}

if (exists(target('github-app.json')) && !opt.force) {
  fail(`${target('github-app.json')} exists; pass --force to replace it`, 2);
}

const owner = resolveOwner();
const state = randomBytes(24).toString('hex');
let port = 0;
let used = false;
const page = (status: number, body: string, res: http.ServerResponse) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(`<!doctype html><meta charset="utf-8"><title>job-hopper</title>${body}`);
};

const server = http.createServer((req, res) => {
  if (req.headers.host !== `127.0.0.1:${port}`) return page(421, '<p>Misdirected request.</p>', res);
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  if (req.method === 'GET' && url.pathname === '/') {
    const action = `${web}/${opt.org ? `organizations/${encodeURIComponent(opt.org)}/` : ''}settings/apps/new?state=${state}`;
    return page(200, `<form id="f" method="post" action="${escapeHtml(action)}">` +
      `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(buildManifest(owner, port)))}">` +
      '<noscript><button>Continue to GitHub</button></noscript></form><script>document.getElementById("f").submit()</script>', res);
  }
  if (req.method === 'GET' && url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (url.searchParams.get('state') !== state || !code) return page(400, '<p>Bad state or code. Nothing stored.</p>', res);
    if (used) return page(409, '<p>This callback was already used.</p>', res);
    used = true;
    void finish(code, res);
    return;
  }
  page(404, '<p>Not found.</p>', res);
});

async function finish(code: string, res: http.ServerResponse): Promise<void> {
  try {
    const c = await convert(code);
    const path = writeConfig(c);
    const install = `${web}/apps/${c.slug}/installations/new`;
    page(200, `<h1>App created</h1><p><a href="${escapeHtml(install)}">Install it on your repositories</a></p>`, res);
    process.stdout.write(`\nApp created: ${c.slug}\nInstall it: ${install}\nConfig: ${path}\nJOB_HOPPER_APP_CREATED ${path}\n`);
    res.on('close', () => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  } catch (e) {
    page(502, '<p>App creation failed. See the terminal.</p>', res);
    res.on('close', () => fail(e instanceof Error ? e.message : String(e)));
    setTimeout(() => fail(String(e)), 1000).unref();
  }
}

server.listen(0, '127.0.0.1', () => {
  port = (server.address() as { port: number }).port;
  const start = `http://127.0.0.1:${port}/`;
  process.stdout.write(`Open this page to create the GitHub App for ${owner}:\n${start}\n`);
  try { spawnSync('qrencode', ['-t', 'ANSIUTF8', start], { stdio: 'inherit' }); } catch { /* best effort */ }
  if (!opt['no-open']) {
    try { spawn('xdg-open', [start], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* best effort */ }
  }
  setTimeout(() => fail('timed out waiting for GitHub; nothing written'), timeoutMs).unref();
});
