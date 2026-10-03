// DNS-rebinding guard (design.md "Read-only API"): every request — GET, SSE and the UI included —
// must name this daemon in Host, as 127.0.0.1:<port> or localhost:<port> with the bound port.
// Anything else is 421: a page on another name that resolves to 127.0.0.1 reads nothing.
import type { FastifyInstance } from 'fastify';

export function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function installHostGuard(app: FastifyInstance, port: () => number): void {
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host ?? '';
    if (allowedHosts(port()).includes(host.toLowerCase())) return;
    console.warn(`job-hopper: refused Host ${JSON.stringify(host)} for ${req.method} ${req.url} (421)`);
    return reply.code(421).send({ error: `misdirected request: Host must be ${allowedHosts(port()).join(' or ')}` });
  });
}
