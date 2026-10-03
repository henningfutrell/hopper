import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'create-github-app.sh');
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const CLIENT_SECRET = 'client-secret-must-not-be-stored';

type Conversion = { code: string };
type Fake = { url: string; calls: Conversion[]; close(): Promise<void> };

async function startFake(o: { delayMs?: number; webhookSecret?: string | null; status?: number } = {}): Promise<Fake> {
  const calls: Conversion[] = [];
  const server = http.createServer((req, res) => {
    const m = /^\/app-manifests\/([^/]+)\/conversions$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) {
      res.writeHead(404).end('{}');
      return;
    }
    calls.push({ code: m[1]! });
    setTimeout(() => {
      if (o.status && o.status !== 201) {
        res.writeHead(o.status, { 'content-type': 'application/json' }).end('{"message":"Not Found"}');
        return;
      }
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({
        id: 123456, slug: 'renamed-by-owner', client_id: 'Iv23abc', client_secret: CLIENT_SECRET,
        webhook_secret: o.webhookSecret === undefined ? 'whsec-123' : o.webhookSecret, pem: PEM,
        html_url: 'https://github.com/apps/renamed-by-owner', owner: { login: 'tester' },
      }));
    }, o.delayMs ?? 0);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

type Run = { proc: ChildProcess; out: () => string; err: () => string; startUrl: string; port: number; exited: Promise<number | null> };

async function run(args: string[], env: Record<string, string>): Promise<Run> {
  const proc = spawn('bash', [SCRIPT, '--no-open', '--owner', 'tester', ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
  let out = '';
  let err = '';
  proc.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  proc.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<number | null>((r) => proc.on('exit', (code) => r(code)));
  const started = Date.now();
  let startUrl = '';
  while (!startUrl && Date.now() - started < 8000) {
    const m = /(http:\/\/127\.0\.0\.1:\d+\/)\s/.exec(out);
    if (m) startUrl = m[1]!;
    else if (proc.exitCode !== null) break;
    else await new Promise((r) => setTimeout(r, 25));
  }
  const port = startUrl ? Number(new URL(startUrl).port) : 0;
  return { proc, out: () => out, err: () => err, startUrl, port, exited };
}

const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function startPage(r: Run): Promise<{ action: string; manifest: Record<string, unknown> }> {
  const html = await (await fetch(r.startUrl)).text();
  const action = /<form[^>]*action="([^"]+)"/.exec(html)![1]!;
  const manifest = /name="manifest"[^>]*value="([^"]*)"/.exec(html)![1]!;
  return { action: unescape(action), manifest: JSON.parse(unescape(manifest)) as Record<string, unknown> };
}

const stateOf = (action: string) => new URL(action).searchParams.get('state')!;

function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }).on('error', reject);
  });
}

describe('create-github-app.sh', () => {
  let fake: Fake;
  let dir: string;
  let runs: Run[];
  const env = (extra: Record<string, string> = {}) => ({
    JOB_HOPPER_GITHUB_WEB: fake.url, JOB_HOPPER_GITHUB_API: fake.url, JOB_HOPPER_CONFIG_DIR: dir, ...extra,
  });
  const go = async (args: string[], extra: Record<string, string> = {}) => { const r = await run(args, env(extra)); runs.push(r); return r; };
  const files = () => readdirSync(dir).sort();
  const mode = (f: string) => (lstatSync(join(dir, f)).mode & 0o777).toString(8);

  beforeEach(async () => {
    fake = await startFake();
    dir = mkdtempSync(join(tmpdir(), 'jh-app-'));
    runs = [];
  });
  afterEach(async () => {
    for (const r of runs) r.proc.kill('SIGKILL');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves a start page that auto-submits the manifest to GitHub with a state', async () => {
    const r = await go([]);
    const { action, manifest } = await startPage(r);
    expect(action).toBe(`${fake.url}/settings/apps/new?state=${stateOf(action)}`);
    expect(stateOf(action).length).toBeGreaterThanOrEqual(32);
    expect(manifest).toEqual({
      name: 'job-hopper-tester',
      url: 'https://github.com/tester',
      description: "Pulls jobs for job-hopper on the owner's laptop from issues labelled hopper.",
      hook_attributes: { url: 'https://example.invalid/job-hopper-webhook', active: false },
      redirect_url: `http://127.0.0.1:${r.port}/callback`,
      public: false,
      default_permissions: { issues: 'write', metadata: 'read', organization_projects: 'read' },
      default_events: [],
    });
  });

  it('--no-webhook omits hook_attributes; --name overrides; names are cut to 34 chars', async () => {
    const r = await go(['--no-webhook', '--name', 'x'.repeat(50)]);
    const { manifest } = await startPage(r);
    expect(manifest).not.toHaveProperty('hook_attributes');
    expect(manifest.name).toBe('x'.repeat(34));
  });

  it('--org posts to the organization settings URL', async () => {
    const r = await go(['--org', 'acme']);
    const { action } = await startPage(r);
    expect(action.startsWith(`${fake.url}/organizations/acme/settings/apps/new?state=`)).toBe(true);
  });

  it('on a valid callback converts the code and writes 600 files from the response, never the client secret', async () => {
    const r = await go([]);
    const { action } = await startPage(r);
    const res = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/apps/renamed-by-owner/installations/new');
    expect(await r.exited).toBe(0);

    expect(fake.calls).toEqual([{ code: 'abc' }]);
    expect(files()).toEqual(['github-app-webhook.secret', 'github-app.json', 'github-app.pem']);
    for (const f of files()) expect(mode(f)).toBe('600');
    expect(JSON.parse(readFileSync(join(dir, 'github-app.json'), 'utf8'))).toEqual({
      version: 1, appId: 123456, slug: 'renamed-by-owner', botLogin: 'renamed-by-owner[bot]', clientId: 'Iv23abc',
      htmlUrl: 'https://github.com/apps/renamed-by-owner', owner: 'tester',
      privateKeyFile: join(dir, 'github-app.pem'), webhookSecretFile: join(dir, 'github-app-webhook.secret'),
      createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(readFileSync(join(dir, 'github-app.pem'), 'utf8')).toBe(PEM);
    expect(readFileSync(join(dir, 'github-app-webhook.secret'), 'utf8').trim()).toBe('whsec-123');
    for (const f of files()) expect(readFileSync(join(dir, f), 'utf8')).not.toContain(CLIENT_SECRET);

    const lines = r.out().trim().split('\n');
    expect(lines.at(-1)).toBe(`JOB_HOPPER_APP_CREATED ${join(dir, 'github-app.json')}`);
    expect(r.out()).toContain(`${fake.url}/apps/renamed-by-owner/installations/new`);
    expect(r.out()).toContain(r.startUrl);
  });

  it('a null webhook_secret writes no secret file and webhookSecretFile null', async () => {
    await fake.close();
    fake = await startFake({ webhookSecret: null });
    const r = await go(['--no-webhook']);
    const { action } = await startPage(r);
    await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(await r.exited).toBe(0);
    expect(files()).toEqual(['github-app.json', 'github-app.pem']);
    expect(JSON.parse(readFileSync(join(dir, 'github-app.json'), 'utf8')).webhookSecretFile).toBeNull();
  });

  it('a wrong state answers 400, converts nothing, writes nothing, and the flow stays open', async () => {
    const r = await go([]);
    const { action } = await startPage(r);
    const bad = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=nope`);
    expect(bad.status).toBe(400);
    expect(fake.calls).toEqual([]);
    expect(files()).toEqual([]);
    const good = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(good.status).toBe(200);
    expect(await r.exited).toBe(0);
  });

  it('accepts the callback once: a second valid callback during conversion is refused', async () => {
    await fake.close();
    fake = await startFake({ delayMs: 400 });
    const r = await go([]);
    const { action } = await startPage(r);
    const url = `http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`;
    const first = fetch(url);
    await new Promise((x) => setTimeout(x, 100));
    const second = await fetch(url);
    expect(second.status).toBe(409);
    expect((await first).status).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(await r.exited).toBe(0);
  });

  it('refuses requests whose Host is not 127.0.0.1:<port>', async () => {
    const r = await go([]);
    const { action } = await startPage(r);
    expect(await rawGet(r.port, '/', 'evil.example')).toBe(421);
    expect(await rawGet(r.port, `/callback?code=abc&state=${stateOf(action)}`, `evil.example:${r.port}`)).toBe(421);
    expect(fake.calls).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('a failed conversion exits 1 and writes nothing', async () => {
    await fake.close();
    fake = await startFake({ status: 404 });
    const r = await go([]);
    const { action } = await startPage(r);
    const res = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(res.status).toBe(502);
    expect(await r.exited).toBe(1);
    expect(files()).toEqual([]);
  });

  it('refuses with exit 2 when github-app.json exists, leaving it alone', async () => {
    writeFileSync(join(dir, 'github-app.json'), 'OLD');
    const r = await go([]);
    expect(await r.exited).toBe(2);
    expect(r.startUrl).toBe('');
    expect(readFileSync(join(dir, 'github-app.json'), 'utf8')).toBe('OLD');
    expect(r.err()).toContain('--force');
  });

  it('--force replaces an existing config', async () => {
    writeFileSync(join(dir, 'github-app.json'), 'OLD');
    const r = await go(['--force']);
    const { action } = await startPage(r);
    await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(await r.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'github-app.json'), 'utf8')).slug).toBe('renamed-by-owner');
    expect(files().filter((f) => f.includes('tmp'))).toEqual([]);
  });

  it('times out after JOB_HOPPER_APP_FLOW_TIMEOUT_MS with exit 1 and nothing written', async () => {
    const r = await go([], { JOB_HOPPER_APP_FLOW_TIMEOUT_MS: '300' });
    expect(await r.exited).toBe(1);
    expect(files()).toEqual([]);
    expect(r.err()).toMatch(/timed out/i);
  });

  it('refuses a symlink at a target path and writes through nothing', async () => {
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const cfg = join(dir, 'cfg');
    mkdirSync(cfg);
    writeFileSync(join(elsewhere, 'victim'), 'KEEP');
    symlinkSync(join(elsewhere, 'victim'), join(cfg, 'github-app.pem'));
    const r = await run([], { ...env(), JOB_HOPPER_CONFIG_DIR: cfg });
    runs.push(r);
    const { action } = await startPage(r);
    await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(await r.exited).toBe(1);
    expect(readFileSync(join(elsewhere, 'victim'), 'utf8')).toBe('KEEP');
    expect(existsSync(join(cfg, 'github-app.json'))).toBe(false);
    expect(r.err()).toMatch(/symlink/i);
  });
});
