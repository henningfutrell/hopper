// Every request a span, and its latency recorded (issue #1486, design.md "Telemetry"). The span is named by the route's
// template (`POST /ui/api/jobs/:id/approve`), never the URL: no id, query or token in a path goes out, nor any header or
// body. A caller's `traceparent` is its parent, so a machine's call joins the trace that asked for it. The span is the
// active context from the hook on, so the handler's own spans, GitHub calls and log lines are its children. The latency
// histogram is the semantic conventions' `http.server.request.duration`, by method, route and status: a UI action's
// latency is its route's, and the telemetry summary keeps it (`summary.ts`).
import { context, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { instrument, tracer } from './instruments.ts';
import { telemetrySummary } from './summary.ts';

const duration = instrument((m) => m.createHistogram('http.server.request.duration', { unit: 's', description: 'How long the hopper took to answer a request.' }));

interface Open { span: Span; ctx: Context; from: number }

export function instrumentHttp(app: FastifyInstance): void {
  const open = new WeakMap<FastifyRequest, Open>();
  const routeOf = (req: FastifyRequest): string | undefined => req.routeOptions.url;
  const end = (req: FastifyRequest, status: number | undefined): void => {
    const o = open.get(req);
    if (!o) return;
    open.delete(req);
    const route = routeOf(req);
    const attributes = {
      'http.request.method': req.method,
      ...(route ? { 'http.route': route } : {}),
      ...(status !== undefined ? { 'http.response.status_code': status } : {}),
    };
    o.span.setAttributes(attributes);
    if (status === undefined || status >= 500) o.span.setStatus({ code: SpanStatusCode.ERROR });
    o.span.end();
    const seconds = (performance.now() - o.from) / 1000;
    duration().record(seconds, attributes);
    telemetrySummary.action(req.method, route, seconds);
  };

  app.addHook('onRequest', (req, _reply, done) => {
    const route = routeOf(req);
    const parent = propagation.extract(context.active(), req.headers);
    const span = tracer().startSpan(route ? `${req.method} ${route}` : req.method, {
      kind: SpanKind.SERVER, attributes: { 'http.request.method': req.method, ...(route ? { 'http.route': route } : {}) },
    }, parent);
    const ctx = trace.setSpan(parent, span);
    open.set(req, { span, ctx, from: performance.now() });
    context.with(ctx, done);
  });
  // The body is read between the hooks, off this context: the handler gets it back here.
  app.addHook('preHandler', (req, _reply, done) => {
    const o = open.get(req);
    if (o) context.with(o.ctx, done);
    else done();
  });
  app.addHook('onError', (req, _reply, error, done) => {
    // The error's kind only: its message may carry what the request carried.
    open.get(req)?.span.setAttribute('error.type', error.name || 'Error');
    done();
  });
  app.addHook('onResponse', (req, reply, done) => { end(req, reply.statusCode); done(); });
  app.addHook('onRequestAbort', (req, done) => { end(req, undefined); done(); });
}
