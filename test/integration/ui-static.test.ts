// The UI is a built bundle (ui/ → `npm run build:ui` → ui/dist): `/` is its index.html, its
// hashed files are under /ui/assets/. A daemon whose bundle was never built says so, loudly.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { request } from 'node:http';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

function bundle(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'hopper-ui-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

// The path goes on the wire as written: URL and fetch would resolve the dot segments first.
function statusOf(base: string, path: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    request({ host: hostname, port, path, headers: { host: `${hostname}:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject).end();
  });
}

async function start(uiDir: string): Promise<TestApp> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  t = await startTestApp({ dbPath: db.dbPath, seams: { uiDir } });
  return t;
}

describe('the built UI', () => {
  it('serves index.html at / and hashed assets under /ui/assets/, cached forever', async () => {
    const app = await start(bundle({
      'index.html': '<!doctype html><script type="module" src="/ui/assets/index-abc123.js"></script>',
      'assets/index-abc123.js': 'console.log(1)',
      'assets/index-def456.css': 'body{}',
    }));
    const page = await fetch(app.url + '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toContain('/ui/assets/index-abc123.js');
    const js = await fetch(app.url + '/ui/assets/index-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(await js.text()).toBe('console.log(1)');
    expect((await fetch(app.url + '/ui/assets/index-def456.css')).headers.get('content-type')).toMatch(/text\/css/);
  });

  it('serves the icon the UI page names as the favicon, at /favicon.svg and /favicon.ico (issue #183)', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
    const app = await start(bundle({
      'index.html': '<!doctype html><link rel="icon" type="image/svg+xml" href="/ui/assets/hopper-logo-abc123.svg" />',
      'assets/hopper-logo-abc123.svg': svg,
      'assets/other-def456.svg': '<svg/>',
    }));
    for (const path of ['/favicon.svg', '/favicon.ico']) {
      const res = await fetch(app.url + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toBe('image/svg+xml');
      expect(await res.text(), path).toBe(svg);
    }
  });

  it('serves nothing outside the assets directory', async () => {
    const app = await start(bundle({ 'index.html': 'x', 'assets/a.js': 'a', 'secret.txt': 's' }));
    for (const path of ['/favicon.svg', '/favicon.ico', '/ui/assets/../secret.txt', '/ui/assets/%2e%2e/secret.txt', '/ui/assets/%2e%2e%2fsecret.txt', '/ui/assets/missing.js', '/ui/app.js']) {
      expect(await statusOf(app.url, path), path).toBe(404);
    }
  });

  it('a bundle never built answers / with 503 naming the command that builds it', async () => {
    const app = await start(bundle({}));
    const res = await app.api('GET', '/');
    expect(res.status).toBe(503);
    expect(res.body.error).toContain('npm run build:ui');
    expect((await app.api('GET', '/api/health')).status).toBe(200);
  });
});
