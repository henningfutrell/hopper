import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'create-github-app.ts');
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
  const proc = spawn(process.execPath, [SCRIPT, '--no-open', '--owner', 'tester', ...args], { env: { ...process.env, ...env }, stdio: 'pipe' });
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

describe('create-github-app.ts', () => {
  let fake: Fake;
  let dir: string;
  let runs: Run[];
  const env = (extra: Record<string, string> = {}) => ({
    HOPPER_GITHUB_WEB: fake.url, HOPPER_GITHUB_API: fake.url, ...extra,
  });
  const envFile = () => join(dir, 'daemon.env');
  const go = async (args: string[], extra: Record<string, string> = {}) => { const r = await run(['--secrets-file', envFile(), ...args], env(extra)); runs.push(r); return r; };
  const files = () => readdirSync(dir).sort();
  const mode = (f: string) => (lstatSync(f).mode & 0o777).toString(8);
  const read = () => readFileSync(envFile(), 'utf8');
  const lineOf = (key: string) => read().split('\n').find((l) => l.startsWith(`${key}=`));
  const expectUntouched = () => { expect(files()).toEqual(['daemon.env']); expect(read()).toBe(''); };
  const callback = async (r: Run) => { const { action } = await startPage(r); return fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`); };

  beforeEach(async () => {
    fake = await startFake();
    dir = mkdtempSync(join(tmpdir(), 'jh-app-'));
    runs = [];
    // Node itself reads `--secrets-file` anywhere in argv and exits 9 when the file is missing, so every run starts with one.
    writeFileSync(envFile(), '');
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
      name: 'hopper-tester',
      url: 'https://github.com/tester',
      description: "Pulls jobs for hopper from issues labelled hopper.",
      hook_attributes: { url: 'https://example.invalid/hopper-webhook', active: false },
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

  it('on a valid callback converts the code and writes one 600 env file from the response, never the client secret', async () => {
    const r = await go([]);
    const { action } = await startPage(r);
    const res = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/apps/renamed-by-owner/installations/new');
    expect(await r.exited).toBe(0);

    expect(fake.calls).toEqual([{ code: 'abc' }]);
    expect(files()).toEqual(['daemon.env']);
    expect(mode(envFile())).toBe('600');
    expect(lineOf('GITHUB_APP_WEBHOOK_SECRET')).toBe('GITHUB_APP_WEBHOOK_SECRET=whsec-123');
    expect(read()).not.toContain(CLIENT_SECRET);

    const lines = r.out().trim().split('\n');
    expect(lines.at(-1)).toBe('HOPPER_APP_CREATED 123456 renamed-by-owner');
    expect(r.out()).toContain('appId: 123456, slug: renamed-by-owner');
    expect(r.out()).toContain('in the UI (Plugins → Job sources)');
    expect(r.out()).toContain(`${fake.url}/apps/renamed-by-owner/installations/new`);
    expect(r.out()).toContain(r.startUrl);
    expect(r.out()).not.toContain('BEGIN RSA');
  });

  it('writes the private key as one line whose \\n escapes round-trip to the PEM', async () => {
    const r = await go([]);
    expect(await (await callback(r)).text()).toContain('App created');
    expect(await r.exited).toBe(0);
    const key = lineOf('GITHUB_APP_PRIVATE_KEY')!;
    expect(key.includes('\n')).toBe(false);
    const value = key.slice('GITHUB_APP_PRIVATE_KEY='.length);
    expect(value).not.toMatch(/\n$/);
    expect(value.replaceAll('\\n', '\n') + '\n').toBe(PEM.trim() + '\n');
  });

  it('keeps the env file\'s other lines', async () => {
    writeFileSync(envFile(), 'HOPPER_DATABASE_URL=postgres://u@db/x\nOTHER=1\n');
    const r = await go([]);
    await callback(r);
    expect(await r.exited).toBe(0);
    const lines = read().split('\n');
    expect(lines).toContain('HOPPER_DATABASE_URL=postgres://u@db/x');
    expect(lines).toContain('OTHER=1');
    expect(lineOf('GITHUB_APP_PRIVATE_KEY')).toBeDefined();
    expect(read().endsWith('\n')).toBe(true);
    expect(mode(envFile())).toBe('600');
  });

  it('a null webhook_secret writes no webhook secret line', async () => {
    await fake.close();
    fake = await startFake({ webhookSecret: null });
    writeFileSync(envFile(), 'GITHUB_APP_WEBHOOK_SECRET=stale\n');
    const r = await go(['--no-webhook']);
    await callback(r);
    expect(await r.exited).toBe(0);
    expect(lineOf('GITHUB_APP_WEBHOOK_SECRET')).toBeUndefined();
    expect(lineOf('GITHUB_APP_PRIVATE_KEY')).toBeDefined();
  });

  it('a wrong state answers 400, converts nothing, writes nothing, and the flow stays open', async () => {
    const r = await go([]);
    const { action } = await startPage(r);
    const bad = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=nope`);
    expect(bad.status).toBe(400);
    expect(fake.calls).toEqual([]);
    expectUntouched();
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
    expectUntouched();
  });

  it('a failed conversion exits 1 and writes nothing', async () => {
    await fake.close();
    fake = await startFake({ status: 404 });
    const r = await go([]);
    const { action } = await startPage(r);
    const res = await fetch(`http://127.0.0.1:${r.port}/callback?code=abc&state=${stateOf(action)}`);
    expect(res.status).toBe(502);
    expect(await r.exited).toBe(1);
    expectUntouched();
  });

  it('refuses with exit 2 when the env file already holds a key, leaving it alone', async () => {
    const old = 'KEEP=1\nGITHUB_APP_PRIVATE_KEY=OLD\n';
    writeFileSync(envFile(), old);
    const r = await go([]);
    expect(await r.exited).toBe(2);
    expect(r.startUrl).toBe('');
    expect(read()).toBe(old);
    expect(r.err()).toContain('--force');
  });

  it('--force replaces an existing key', async () => {
    writeFileSync(envFile(), 'KEEP=1\nGITHUB_APP_PRIVATE_KEY=OLD\n');
    const r = await go(['--force']);
    await callback(r);
    expect(await r.exited).toBe(0);
    expect(read()).not.toContain('OLD');
    expect(read().split('\n')).toContain('KEEP=1');
    expect(read().match(/^GITHUB_APP_PRIVATE_KEY=/gm)).toHaveLength(1);
    expect(files().filter((f) => f.includes('tmp'))).toEqual([]);
  });

  it('times out after HOPPER_APP_FLOW_TIMEOUT_MS with exit 1 and nothing written', async () => {
    const r = await go([], { HOPPER_APP_FLOW_TIMEOUT_MS: '300' });
    expect(await r.exited).toBe(1);
    expectUntouched();
    expect(r.err()).toMatch(/timed out/i);
  });

  it('refuses a symlink as the env file and writes through nothing', async () => {
    const victim = join(dir, 'victim');
    writeFileSync(victim, 'KEEP');
    rmSync(envFile());
    symlinkSync(victim, envFile());
    const r = await go([]);
    await callback(r);
    expect(await r.exited).toBe(1);
    expect(readFileSync(victim, 'utf8')).toBe('KEEP');
    expect(lstatSync(envFile()).isSymbolicLink()).toBe(true);
    expect(files().filter((f) => f.includes('tmp'))).toEqual([]);
    expect(r.err()).toMatch(/symlink/i);
  });
});
