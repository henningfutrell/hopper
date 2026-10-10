// The GitHub Pages site (issue #382): `npm run build:site` → site/dist, which .github/workflows/pages.yml
// publishes. Three pages, index.html, install.html and guide.html (the user guide, issue #556), styled by site.css (the UI's own stylesheet). The
// pages mark where the shared parts go with comments — <!--story:headline-->, <!--story:steps-->,
// <!--tour--> and the like — and the build renders them from ui/src/app/story.ts and site/tour.ts. The build also
// publishes what the site served before it had one: scripts/get.sh as install.sh, compose.yaml (and compose.sandboxes.yaml, issue #603), the logo.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { defineConfig, type Plugin } from 'vite';
import { Backdrop, HEADLINE, KICKER, LEAD, StorySteps } from '../ui/src/app/story.ts';
import { renderTour } from './tour.ts';

const at = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/** The served files that are not pages: published under their own names, unhashed. */
const SERVED: Record<string, string> = {
  'install.sh': at('../scripts/get.sh'),
  'compose.yaml': at('../compose.yaml'),
  'compose.sandboxes.yaml': at('../compose.sandboxes.yaml'),
  'hopper-logo.svg': at('./hopper-logo.svg'),
};

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
  plugins: [tailwindcss(), pages()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: { index: at('./index.html'), install: at('./install.html'), guide: at('./guide.html') } },
  },
});
