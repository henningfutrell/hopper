// The diagram and chart libraries the hopper bundles for artifacts (issue #675, design.md "Artifacts: dynamic pages"):
// an artifact is a dynamic page, and its sandbox loads nothing from outside (issue #673), so the hopper serves these
// itself at `/artifact-lib/<file>`, and an HTML artifact's policy lets it load scripts from there and nowhere else.
// `npm run build:ui` copies them from node_modules into `ui/dist/artifact-lib/` (scripts/copy-artifact-libs.ts): the
// image keeps the three files, not the packages. A fixed name → buffer map read at startup: no path reaches the disk.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** Where the libraries are served. */
export const ARTIFACT_LIB_PATH = '/artifact-lib';

/** Each library: the file it is served as, where npm installs it, and what a job uses it for (the skill help says it). */
export const ARTIFACT_LIBS = [
  { file: 'mermaid.js', from: 'mermaid/dist/mermaid.min.js', global: 'mermaid', what: 'Mermaid 12: flowcharts, sequence, state, class and Gantt diagrams from text' },
  { file: 'chart.js', from: 'chart.js/dist/chart.umd.min.js', global: 'Chart', what: 'Chart.js 4: bar, line, pie, scatter charts' },
  { file: 'd3.js', from: 'd3/dist/d3.min.js', global: 'd3', what: 'D3 7: any custom drawing, scales and axes, SVG you build' },
] as const;

/** Copies each library from node_modules into `dir`. */
export function copyArtifactLibs(dir: string): void {
  // A package's `exports` may not name its dist file: find the package's own dir where Node looks, then the file in it.
  const paths = createRequire(import.meta.url).resolve.paths('') ?? [];
  mkdirSync(dir, { recursive: true });
  for (const lib of ARTIFACT_LIBS) {
    const from = paths.map((p) => join(p, lib.from)).find((f) => existsSync(f));
    if (!from) throw new Error(`hopper: ${lib.from} is not installed: run npm ci with the dev dependencies`);
    copyFileSync(from, join(dir, lib.file));
  }
}

const NOT_BUILT = 'no: the artifact libraries are not built: run npm run build:ui in the hopper checkout, then restart\n';

/**
 * Serves the libraries from `dir` (ui/dist/artifact-lib). A dir that is not there is a hopper whose UI is not built: each
 * answers 503, as the UI does. A dir with a library missing is a broken build: refused at startup, by name.
 */
export function artifactLibRoutes(app: Pick<FastifyInstance, 'get'>, dir: string): void {
  if (!existsSync(dir)) {
    app.get(`${ARTIFACT_LIB_PATH}/:file`, async (_req, reply) => reply.code(503).type('text/plain; charset=utf-8').send(NOT_BUILT));
    return;
  }
  const missing = ARTIFACT_LIBS.filter((l) => !existsSync(join(dir, l.file))).map((l) => l.file);
  if (missing.length > 0) throw new Error(`hopper: the artifact libraries in ${dir} lack ${missing.join(', ')}: run npm run build:ui again`);
  for (const lib of ARTIFACT_LIBS) {
    const body = readFileSync(join(dir, lib.file));
    app.get(`${ARTIFACT_LIB_PATH}/${lib.file}`, async (_req, reply) => reply.headers({
      'content-type': 'text/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
      // An artifact's sandbox has an opaque origin: to it the hopper is another origin.
      'cross-origin-resource-policy': 'cross-origin',
      'cache-control': 'public, max-age=86400',
    }).send(body));
  }
}
