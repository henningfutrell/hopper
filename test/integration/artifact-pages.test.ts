// Issue #675: an artifact is a presentation medium — a shareable, meaningful, dynamic page. The real daemon, a joined
// machine and the real `hopper-artifact`.
//
// Feature: dynamic pages
//   Scenario: the hopper serves its bundled diagram and chart libraries, and an HTML page may load them, and nothing else
//     Given the hopper bundles Mermaid, Chart.js and D3 at /artifact-lib/
//     When a person opens an HTML artifact
//     Then its policy lets it load scripts from the hopper's /artifact-lib/ only, at the address the person used
//     And the libraries are served to the sandbox's opaque origin
// Feature: meaningful and shareable
//   Scenario: each artifact has a title and a one-line summary; a put with no summary is kept, with a warning
//   Scenario: a public link opens a page that fits a phone, with the title and summary for share previews
//   Scenario: the skill help frames an artifact as a presentation medium, with an interactive flowchart and a chart
//     a person can filter, and the revision commands
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ARTIFACT_LIBS, artifactLibRoutes, copyArtifactLibs } from '../../src/artifacts/libs.ts';
import { htmlPolicy } from '../../src/artifacts/content.ts';
import { ARTIFACT_HELP } from '../../src/artifacts/script.ts';
import { visualWarning } from '../../src/domain/artifacts.ts';
import type { ArtifactView } from '../../src/domain/types.ts';
import { artifactHarness, readArtifacts as read } from '../support/artifacts.ts';

const h = artifactHarness();
afterEach(() => h.stop());

const FLOW = '<!doctype html><meta name="viewport" content="width=device-width"><title>Flow</title><script src="/artifact-lib/mermaid.js"></script><pre class="mermaid">flowchart LR\n A --> B</pre><script>mermaid.initialize({ startOnLoad: true })</script>\n';

describe('dynamic pages (issue #675)', () => {
  it('copies the bundled libraries from node_modules, and serves them to the sandbox from the hopper itself', async () => {
    expect(ARTIFACT_LIBS.map((l) => l.file)).toEqual(['mermaid.js', 'chart.js', 'd3.js']);
    const dir = mkdtempSync(join(tmpdir(), 'artifact-lib-'));
    try {
      copyArtifactLibs(dir);
      const { default: Fastify } = await import('fastify');
      const app = Fastify();
      artifactLibRoutes(app, dir);
      const res = await app.inject({ method: 'GET', url: '/artifact-lib/chart.js' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
      // The sandbox's origin is opaque: a same-origin resource policy would block the load.
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('Chart');
      expect((await app.inject({ method: 'GET', url: '/artifact-lib/../package.json' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/artifact-lib/other.js' })).statusCode).toBe(404);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a library dir with a file missing is refused at startup, by name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'artifact-lib-'));
    try {
      writeFileSync(join(dir, 'mermaid.js'), '');
      expect(() => artifactLibRoutes({ get: () => undefined } as never, dir)).toThrow(/chart\.js/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an HTML page loads scripts from the hopper\'s /artifact-lib/ only, at the address the person used', async () => {
    const { a, session, job } = await h.boot();
    const { dir } = h.file('flow.html', FLOW);
    const out = JSON.parse((await h.artifact(a, job, ['put', 'flow.html', '--summary', 'A to B', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView; warning?: string };
    // A page that runs a script draws at run time: it is not warned.
    expect(out.warning).toBeUndefined();
    const mine = (await read(a, session)).artifacts.find((x) => x.id === out.artifact.id)!;
    const res = await fetch(a.url + mine.contentUrl);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toBe(htmlPolicy(a.url));
    expect(csp).toContain(`script-src 'unsafe-inline' data: blob: ${a.url}/artifact-lib/;`);
    expect(csp).not.toContain('https:');
    expect(csp).toContain("connect-src 'none'");
    const local = await fetch(a.url.replace('127.0.0.1', 'localhost') + mine.contentUrl);
    expect(local.headers.get('content-security-policy')).toContain(`${a.url.replace('127.0.0.1', 'localhost')}/artifact-lib/;`);
  });

  it('finds what a page shows: a drawing element, or a script that draws at run time', () => {
    expect(visualWarning('html', Buffer.from('<p>steps</p><ol><li>one</li></ol>'))).toMatch(/^the artifact has no visual/);
    expect(visualWarning('html', Buffer.from('<pre class="mermaid">flowchart LR</pre><script src="/artifact-lib/mermaid.js"></script>'))).toBeUndefined();
    expect(visualWarning('html', Buffer.from('<div id="c"></div><script>draw()</script>'))).toBeUndefined();
  });
});

describe('meaningful and shareable (issue #675)', () => {
  it('each artifact has a title and a one-line summary; a put with none is kept with a warning', async () => {
    const { a, session, job } = await h.boot();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>\n';
    const none = JSON.parse((await h.artifact(a, job, ['put', 'a.svg', '--json'], { cwd: h.file('a.svg', svg).dir })).stdout) as { artifact: ArtifactView; warning?: string };
    expect(none.warning).toMatch(/no summary/);
    const given = JSON.parse((await h.artifact(a, job, ['put', 'a.svg', '--title', 'Queue', '--summary', 'Wait by hour:\nlonger at nine', '--json'], { cwd: h.file('a.svg', svg).dir })).stdout) as { artifact: ArtifactView; warning?: string };
    expect(given.warning).toBeUndefined();
    // One line, at most 300 characters.
    expect(given.artifact.summary).toBe('Wait by hour: longer at nine');
    expect((await read(a, session)).artifacts.find((x) => x.id === given.artifact.id)).toMatchObject({ title: 'Queue', summary: 'Wait by hour: longer at nine' });
  });

  it('a public link opens a page that fits a phone, with the title and summary for share previews; its content is framed', async () => {
    const { a, job } = await h.boot();
    const { dir } = h.file('flow.html', FLOW);
    const id = (JSON.parse((await h.artifact(a, job, ['put', 'flow.html', '--title', 'Run <again> flow', '--summary', 'Today & fixed', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView }).artifact.id;
    const link = /^link: (\S+)$/m.exec((await h.artifact(a, job, ['share', id, '--public'])).stdout)![1]!;

    const res = await fetch(link);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-src 'self'");
    expect(csp).not.toContain('script-src');
    const html = await res.text();
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('<title>Run &lt;again&gt; flow</title>');
    expect(html).toContain('<meta property="og:title" content="Run &lt;again&gt; flow">');
    expect(html).toContain('<meta property="og:description" content="Today &amp; fixed">');
    expect(html).toMatch(/<iframe [^>]*sandbox="allow-scripts allow-popups allow-downloads"[^>]*src="[^"]*\/content"/);

    const content = await fetch(`${link}/content`);
    expect(await content.text()).toBe(FLOW);
    expect(content.headers.get('content-security-policy')).toBe(htmlPolicy(new URL(link).origin));
  });

  it('the skill help frames an artifact as a presentation medium, shows an interactive flowchart and a chart to filter, and the revision commands', () => {
    expect(ARTIFACT_HELP).toMatch(/presentation medium/i);
    expect(ARTIFACT_HELP).toMatch(/shareable, meaningful, dynamic page/i);
    expect(ARTIFACT_HELP).toMatch(/prose goes in the issue comment or the job result/i);
    for (const lib of ['/artifact-lib/mermaid.js', '/artifact-lib/chart.js', '/artifact-lib/d3.js']) expect(ARTIFACT_HELP).toContain(lib);
    expect(ARTIFACT_HELP).toContain('Example: an interactive flowchart');
    expect(ARTIFACT_HELP).toContain('Example: a chart a person can filter');
    expect(ARTIFACT_HELP).toMatch(/--summary TEXT/);
    expect(ARTIFACT_HELP).toMatch(/put FILE --to ID/);
    expect(ARTIFACT_HELP).toMatch(/revisions ID/);
    expect(ARTIFACT_HELP).toMatch(/restore ID N/);
    expect(ARTIFACT_HELP).not.toMatch(/CDN/);
    expect(ARTIFACT_HELP).not.toMatch(/https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
  });
});
