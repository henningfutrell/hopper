// The API reference (issue #68, design.md "API reference"): an OpenAPI document of every /api/ and
// /ui/ route, rendered by Scalar at /docs/ from files the daemon serves itself. Readable without a
// session, like the UI's own page; the API it describes still needs one beyond loopback.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { rawRequest } from '../support/http.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

async function start(env?: Record<string, string>): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, ...(env ? { env } : {}) });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

interface Operation { summary?: string; description?: string; parameters?: { name: string; in: string }[]; requestBody?: { content: Record<string, { schema: Record<string, unknown> }> }; security?: unknown[] }
interface OpenApi {
  openapi: string;
  info: { title: string; version: string; description: string };
  paths: Record<string, Record<string, Operation>>;
  components: { securitySchemes: Record<string, { type: string; in?: string; name?: string }> };
}

const get = (a: TestApp, path: string, headers: Record<string, string> = {}) =>
  rawRequest(a.url, { path, headers: { host: new URL(a.url).host, ...headers } });

async function reference(a: TestApp): Promise<OpenApi> {
  const res = await get(a, '/docs/openapi.json');
  expect(res.status).toBe(200);
  return JSON.parse(res.text) as OpenApi;
}

describe('GET /docs/', () => {
  it('is the Scalar API reference, loading only files the daemon serves', async () => {
    const a = await start();
    const page = await get(a, '/docs/');
    expect(page.status).toBe(200);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toContain('js/scalar.js');
    expect(page.text).toContain('./openapi.json');
    // Nothing from a CDN, no fonts, no telemetry, no agent: the page reaches nothing but this daemon.
    expect(page.text).not.toMatch(/https?:\/\//);
    expect(page.text).toMatch(/"telemetry":\s*false/);
    expect(page.text).toMatch(/"withDefaultFonts":\s*false/);
    expect(page.text).toMatch(/"agent":\s*\{\s*"disabled":\s*true/);
    const script = await get(a, '/docs/js/scalar.js');
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toMatch(/javascript/);
    expect((await get(a, '/docs')).status).toBe(301);
  });
});

describe('GET /docs/openapi.json', () => {
  it('is an OpenAPI 3.1 document of this daemon, at its version', async () => {
    const a = await start();
    const doc = await reference(a);
    expect(doc.openapi).toMatch(/^3\.1\./);
    expect(doc.info.title).toBe('hopper');
    expect(doc.info.version).toBe((await a.api<{ version: string }>('GET', '/api/health')).body.version);
    expect(doc.info.description).toMatch(/x-hopper-session/);
    expect(doc.components.securitySchemes.uiSession).toEqual(expect.objectContaining({ type: 'apiKey', in: 'header', name: 'x-hopper-session' }));
    expect((await get(a, '/docs/openapi.yaml')).text).toMatch(/^openapi: 3\.1\./m);
  });

  it('documents every operation with a summary; a mutation names its body from the schema the route parses with', async () => {
    const a = await start();
    const doc = await reference(a);
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(ops)) expect(op.summary, `${method} ${path}`).toBeTruthy();
    }
    expect(doc.paths['/api/jobs/{id}']?.get?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path' })]));
    expect(doc.paths['/api/jobs']?.get?.parameters?.map((p) => p.name)).toEqual(expect.arrayContaining(['status', 'limit']));
    const answer = doc.paths['/ui/api/questions/{id}/answer']?.post;
    expect(answer?.security).toEqual([{ uiSession: [] }]);
    expect(answer?.requestBody?.content['application/json']?.schema).toMatchObject({ type: 'object', required: ['answer'] });
    const update = doc.paths['/ui/api/update']?.post?.requestBody?.content['application/json']?.schema as { oneOf?: unknown[]; anyOf?: unknown[] };
    expect((update.oneOf ?? update.anyOf)?.length).toBe(3);
  });

  it('every documented operation is a route the daemon serves', async () => {
    const a = await start();
    const doc = await reference(a);
    const ops = Object.entries(doc.paths).flatMap(([path, o]) => Object.keys(o).map((m) => ({ method: m.toUpperCase(), path })));
    expect(ops.length).toBeGreaterThan(40);
    expect(ops).toContainEqual({ method: 'GET', path: '/api/events/stream' }); // a stream never ends: the drift check on start covers it
    for (const { method, path } of ops.filter((o) => o.path !== '/api/events/stream')) {
      const res = await rawRequest(a.url, {
        method, path: path.replace(/\{[^}]+\}/g, 'x'), headers: { host: new URL(a.url).host, 'content-type': 'application/json' },
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.text, `${method} ${path}`).not.toMatch(/no route/);
    }
  });
});

describe('across the LAN', () => {
  it('the reference is readable without a session, as the UI page is; the API it describes is not', async () => {
    const a = await start({ HOPPER_LAN_NAMES: 'server', HOPPER_LAN_PEERS: '192.0.2.0/24' });
    const host = `server:${new URL(a.url).port}`;
    expect((await get(a, '/docs/', { host })).status).toBe(200);
    expect((await get(a, '/docs/openapi.json', { host })).status).toBe(200);
    expect((await get(a, '/api/health', { host })).status).toBe(401);
  });
});
