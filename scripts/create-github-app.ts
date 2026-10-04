// Manifest-flow helper: docs/design.md "The manifest-flow helper". Node built-ins only.
// The app's private key (and webhook secret, if GitHub made one) are secrets: they go to the env
// file as GITHUB_APP_PRIVATE_KEY= (newlines as \n) and GITHUB_APP_WEBHOOK_SECRET= lines — by default
// ~/.config/job-hopper/daemon.env, the host unit's EnvironmentFile; --secrets-file for any other deploy,
// whose secret store takes them from there. The app's id and slug are config: set them as the
// github-app instance's appId and slug (`job-hopper config edit plugins.yaml`); the helper prints both.
// Exit codes: 0 created, 1 failure/timeout, 2 refused (the env file already holds a key, no --force).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({
  options: {
    name: { type: 'string' }, owner: { type: 'string' }, org: { type: 'string' },
    'no-webhook': { type: 'boolean' }, force: { type: 'boolean' }, 'no-open': { type: 'boolean' }, 'secrets-file': { type: 'string' },
  },
});

const web = (process.env.JOB_HOPPER_GITHUB_WEB ?? 'https://github.com').replace(/\/$/, '');
const api = (process.env.JOB_HOPPER_GITHUB_API ?? 'https://api.github.com').replace(/\/$/, '');
const envFile = opt['secrets-file'] ?? join(homedir(), '.config', 'job-hopper', 'daemon.env');
const timeoutMs = Number(process.env.JOB_HOPPER_APP_FLOW_TIMEOUT_MS ?? 15 * 60 * 1000);
const SECRET_KEYS = ['GITHUB_APP_PRIVATE_KEY', 'GITHUB_APP_WEBHOOK_SECRET'];

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
    description: "Pulls jobs for job-hopper from issues labelled hopper.",
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

const envText = (): string => (existsSync(envFile) ? readFileSync(envFile, 'utf8') : '');
const holdsKey = (text: string): boolean => text.split('\n').some((l) => l.startsWith('GITHUB_APP_PRIVATE_KEY='));

// Replaces the env file with its other lines plus the app's secrets: checked for a symlink first,
// created 600 under a temp name and renamed into place.
function writeSecrets(c: Conversion): string {
  if (exists(envFile) && lstatSync(envFile).isSymbolicLink()) throw new Error(`refusing symlink at ${envFile}`);
  mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
  const kept = envText().split('\n').filter((l) => l !== '' && !SECRET_KEYS.some((k) => l.startsWith(`${k}=`)));
  const lines = [...kept, `GITHUB_APP_PRIVATE_KEY=${c.pem.trim().replaceAll('\n', '\\n')}`, ...(c.webhook_secret ? [`GITHUB_APP_WEBHOOK_SECRET=${c.webhook_secret}`] : [])];
  const tmp = `${envFile}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, `${lines.join('\n')}\n`); } finally { closeSync(fd); }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, envFile);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already renamed */ }
    throw e;
  }
  return envFile;
}

if (holdsKey(envText()) && !opt.force) {
  fail(`${envFile} already holds GITHUB_APP_PRIVATE_KEY; pass --force to replace it`, 2);
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
    const path = writeSecrets(c);
    const install = `${web}/apps/${c.slug}/installations/new`;
    page(200, `<h1>App created</h1><p><a href="${escapeHtml(install)}">Install it on your repositories</a></p>`, res);
    process.stdout.write(`\nApp created: ${c.slug}\nInstall it: ${install}\nKey: GITHUB_APP_PRIVATE_KEY in ${path}\n` +
      `Set the github-app instance's options (job-hopper config edit plugins.yaml): appId: ${c.id}, slug: ${c.slug}\n` +
      `JOB_HOPPER_APP_CREATED ${c.id} ${c.slug}\n`);
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
