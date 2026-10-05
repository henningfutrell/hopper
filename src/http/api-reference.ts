// GET /docs/: the API reference (issue #68, design.md "API reference") — Scalar
// (@scalar/fastify-api-reference) over the OpenAPI document of src/http/openapi.ts. The page loads
// only what the daemon serves (/docs/js/scalar.js, /docs/openapi.json): no CDN, no fonts, no
// telemetry, no agent, no proxy. Outside /api/, so readable without a session, like the UI's page.
// Registered before the other routes: it records them, and refuses to start when they and the
// document disagree.
import scalar from '@scalar/fastify-api-reference';
import type { FastifyInstance } from 'fastify';
import { openApiDocument, referenceDrift } from './openapi.ts';

export const API_REFERENCE_PATH = '/docs';

export function apiReferenceRoutes(app: FastifyInstance, version: string): void {
  const document = openApiDocument(version);
  const routes: { method: string; url: string }[] = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });
  app.addHook('onReady', async () => {
    const drift = referenceDrift(document as { paths: Record<string, Record<string, unknown>> }, routes);
    if (drift.length) throw new Error(`the API reference is out of step with the routes: ${drift.join('; ')}`);
  });
  void app.register(scalar, {
    routePrefix: API_REFERENCE_PATH,
    logLevel: 'silent',
    configuration: {
      content: document,
      pageTitle: 'hopper API',
      telemetry: false,
      withDefaultFonts: false,
      agent: { disabled: true },
      mcp: { disabled: true },
      hideClientButton: true,
      showDeveloperTools: 'never',
      persistAuth: false,
    },
  });
}
