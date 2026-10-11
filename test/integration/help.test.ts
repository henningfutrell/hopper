// The help pages (issue #782): served by the daemon from help/, the one source. A person reads them as HTML at
// /help/; an agent reads the same text as Markdown at /help/<page>.md and finds the pages at /help/index.json.
// Outside /api/, so readable without a session, like the API reference: they hold no user's data.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_DIR } from '../../src/help/book.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

const get = (a: TestApp, path: string) => rawRequest(a.url, { path, headers: { host: new URL(a.url).host } });

interface Index { version: string; pages: { slug: string; title: string; summary: string; markdown: string; html: string }[] }

describe('GET /help/', () => {
  it('is the contents page: every help page, a page that loads nothing but itself', async () => {
    const a = await start();
    const page = await get(a, '/help/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(page.text).toContain('href="/help/vault"');
    expect(page.text).toContain('name="viewport"');
    expect(page.text).not.toMatch(/<script/);
    expect((await get(a, '/help')).status).toBe(301);
  });

  it('serves each page as HTML, version-matched, with its Markdown named for an agent', async () => {
    const a = await start();
    const { version } = (await a.api<{ version: string }>('GET', '/api/health')).body;
    const page = await get(a, '/help/vault');
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/<h1[^>]*>/);
    expect(page.text).toContain(version);
    expect(page.text).toContain('<link rel="alternate" type="text/markdown" href="/help/vault.md">');
    expect((await get(a, '/help/no-such-page')).status).toBe(404);
  });
});

describe('the help pages for an agent', () => {
  it('lists every page at /help/index.json, and serves each one as the Markdown source', async () => {
    const a = await start();
    const res = await get(a, '/help/index.json');
    expect(res.status).toBe(200);
    const index = JSON.parse(res.text) as Index;
    expect(index.version).toBe((await a.api<{ version: string }>('GET', '/api/health')).body.version);
    const vault = index.pages.find((p) => p.slug === 'vault');
    expect(vault).toEqual(expect.objectContaining({ markdown: '/help/vault.md', html: '/help/vault' }));
    expect(vault!.summary.length).toBeGreaterThan(20);
    const md = await get(a, '/help/vault.md');
    expect(md.status).toBe(200);
    expect(md.headers['content-type']).toMatch(/text\/markdown/);
    expect(md.text).toBe(readFileSync(join(HELP_DIR, 'vault.md'), 'utf8'));
    expect((await get(a, '/help/no-such-page.md')).status).toBe(404);
  });
});
