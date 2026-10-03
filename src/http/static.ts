// The UI: three static files, read once at startup.
import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

const FILES = [
  { route: '/', file: 'index.html', type: 'text/html; charset=utf-8' },
  { route: '/ui/app.js', file: 'app.js', type: 'text/javascript; charset=utf-8' },
  { route: '/ui/style.css', file: 'style.css', type: 'text/css; charset=utf-8' },
];

export function staticRoutes(app: FastifyInstance): void {
  for (const { route, file, type } of FILES) {
    const body = readFileSync(new URL(`../ui/${file}`, import.meta.url));
    app.get(route, async (_req, reply) => reply.type(type).header('cache-control', 'no-cache').send(body));
  }
}
