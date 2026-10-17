// The GitHub Pages site (issue #382): `npm run build:site` → site/dist, which .github/workflows/pages.yml
// publishes. Three pages, index.html, install.html and guide.html (the user guide, issue #556), styled by site.css (the UI's own stylesheet). The
// pages mark where the shared parts go with comments — <!--story:headline-->, <!--story:steps-->,
// <!--tour--> and the like — and the build renders them from ui/src/app/story.ts and site/tour.ts. The build also
// publishes what the site served before it had one: scripts/get.sh as install.sh, compose.yaml, the logo,
// and the hopper CLI for Windows, hopper.cmd and hopper.ps1 (issue #712). And the help pages (issue #790): help/*.md,
// the one source the daemon serves at /help/, rendered into help/<page>.html by site/help.ts, with each page's Markdown
// beside it, version-matched to the checkout the site is built from.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defineConfig, type Plugin } from 'vite';
import { Backdrop, HEADLINE, KICKER, LEAD, StorySteps } from '../ui/src/app/story.ts';
import { helpPageHtml, readHelp } from './help.ts';
import { renderTour } from './tour.ts';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** The served files that are not pages: published under their own names, unhashed. */
const SERVED: Record<string, string> = {
  'install.sh': at('../scripts/get.sh'),
  'compose.yaml': at('../compose.yaml'),
  'hopper.cmd': at('../scripts/hopper.cmd'),
  'hopper.ps1': at('../scripts/hopper.ps1'),
  'hopper-logo.svg': at('./hopper-logo.svg'),
};

/** The branch or tag the site is built from: the workflow's, else the checkout's; none when detached. */
function builtFrom(): string | undefined {
  if (process.env.GITHUB_REF_NAME) return process.env.GITHUB_REF_NAME;
  try {
    const ref = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: at('.'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return ref && ref !== 'HEAD' ? ref : undefined;
  } catch {
    return undefined;
  }
}

/** The help pages, rendered from help/ once every page is built, so each links the one stylesheet the pages share. */
const help = (): Plugin => ({
  name: 'hopper-help',
  generateBundle: {
    order: 'post',
    handler(_options, bundle) {
      const sheet = Object.keys(bundle).find((f) => f.endsWith('.css'));
      if (!sheet) throw new Error('the site built no stylesheet for the help pages to link');
      const { version } = JSON.parse(readFileSync(at('../package.json'), 'utf8')) as { version: string };
      const frame = { stylesheet: `../${sheet}`, version, ref: builtFrom() };
      const all = readHelp(at('../help/'));
      for (const page of all) {
        this.emitFile({ type: 'asset', fileName: `help/${page.slug}.html`, source: helpPageHtml(all, page, frame) });
        this.emitFile({ type: 'asset', fileName: `help/${page.slug}.md`, source: page.markdown });
      }
    },
  },
});

const pages = (): Plugin => {
  let tour = renderTour(at('../docs/screenshots'));
  const text = (s: string): string => renderToStaticMarkup(createElement(Fragment, null, s));
  const parts = (): Record<string, string> => ({
    '<!--story:kicker-->': text(KICKER),
    '<!--story:headline-->': text(HEADLINE),
    '<!--story:lead-->': text(LEAD),
    '<!--story:backdrop-->': renderToStaticMarkup(createElement(Backdrop)),
    '<!--story:steps-->': renderToStaticMarkup(createElement(StorySteps)),
    '<!--tour-->': tour.html,
  });
  return {
    name: 'hopper-pages',
    buildStart() {
      tour = renderTour(at('../docs/screenshots'));
    },
    transformIndexHtml: {
      order: 'post',
      handler: (html) => Object.entries(parts()).reduce((page, [mark, markup]) => page.replaceAll(mark, markup), html),
    },
    generateBundle() {
      const files = [...Object.entries(SERVED).map(([fileName, path]) => ({ fileName, path })), ...tour.files];
      for (const { fileName, path } of files) this.emitFile({ type: 'asset', fileName, source: readFileSync(path) });
    },
  };
};

export default defineConfig({
  root: at('.'),
  base: './',
  publicDir: false,
  plugins: [tailwindcss(), pages(), help()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: { index: at('./index.html'), install: at('./install.html'), guide: at('./guide.html') } },
  },
});
