// The UI: the bundle `npm run build:ui` writes to ui/dist, read once at startup. `/` is its
// index.html; its content-hashed files are under /ui/assets/, cached forever. Only files listed
// at startup are served, so no request path reaches the filesystem. The icon the page names is also
// the favicon at /favicon.svg (linked by every other page the daemon serves) and /favicon.ico (what a
// browser asks for when a page names none): one icon everywhere (issue #183). Hand-rolled rather than
// @fastify/static: a fixed name → buffer map is shorter than that plugin's configuration.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};
/** Where every page the daemon serves outside the UI finds the app's icon. */
export const FAVICON_PATH = '/favicon.svg';
export const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="${FAVICON_PATH}">`;
const NOT_BUILT = 'UI not built: run npm run build:ui in the hopper checkout, then restart';

export function staticRoutes(app: FastifyInstance, uiDir: string): void {
  const index = join(uiDir, 'index.html');
  const page = existsSync(index) ? readFileSync(index) : null;
  app.get('/', async (_req, reply) => {
    if (!page) return reply.code(503).send({ error: NOT_BUILT });
    return reply.type('text/html; charset=utf-8').header('cache-control', 'no-cache').send(page);
  });
  const assets = join(uiDir, 'assets');
  if (!existsSync(assets)) return;
  const icon = page && /<link rel="icon"[^>]*href="\/ui\/assets\/([^"/]+)"/.exec(page.toString('utf8'))?.[1];
  for (const name of readdirSync(assets)) {
    const type = TYPES[extname(name)];
    if (!type) continue;
    const body = readFileSync(join(assets, name));
    app.get(`/ui/assets/${name}`, async (_req, reply) =>
      reply.type(type).header('cache-control', 'public, max-age=31536000, immutable').send(body));
    if (name !== icon) continue;
    for (const path of [FAVICON_PATH, '/favicon.ico']) {
      app.get(path, async (_req, reply) => reply.type(type).header('cache-control', 'no-cache').send(body));
    }
  }
}
