// Builds the GitHub Pages front page from README.md (issue #88): `node scripts/build-pages.ts <site dir>`
// writes <site dir>/index.html. The page carries the one-line install and links the step-by-step install
// page (site/install.html) beside it. Links to repository files go to GitHub; headings get the ids GitHub
// gives them, so the README's own #links land. The page is committed, and .github/workflows/pages.yml
// publishes it with the rest of site/; test/scripts/pages-readme.test.ts fails while it lags README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked, type Tokens } from 'marked';

const REPO = 'https://github.com/henningfutrell/hopper';
const INSTALL = 'curl -fsSL https://henningfutrell.github.io/hopper/install.sh | bash';

// The ids site/install.html had when it was the front page. A link like /hopper/#windows still lands
// there.
const INSTALL_IDS = ['podman', 'first-job', 'host', 'before', 'install', 'own-postgres', 'running', 'ui', 'github', 'windows', 'upgrade', 'remove', 'trouble', 'more'];

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// GitHub's heading anchors: lower case, punctuation dropped, each space a hyphen, repeats numbered.
const slugger = (): ((text: string) => string) => {
  const seen = new Map<string, number>();
  return (text) => {
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  };
};

const link = (href: string): string => {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  if (href === 'site/hopper-logo.svg') return 'hopper-logo.svg';
  return `${REPO}/blob/main/${href.replace(/^\.\//, '')}`;
};

export const renderReadme = (markdown: string): string => {
  const slug = slugger();
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading): string {
        const plain = text.replace(/<[^>]+>/g, '').replace(/`/g, '');
        return `<h${depth} id="${slug(plain)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') token.href = link(token.href);
    },
    hooks: {
      postprocess: (html) => html.replace(/<img src="(?!https?:)([^"]+)"/g, (_, src: string) => `<img src="${link(src)}"`),
    },
  });
  return marked.parse(markdown, { async: false });
};

const page = (body: string, css: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>hopper</title>
<meta name="description" content="A self-hosted job queue for coding agents: it turns GitHub issues into finished work.">
<link rel="icon" type="image/svg+xml" href="hopper-logo.svg">
<script>
// The install page used to be this page: send its old addresses there.
if ([${INSTALL_IDS.map((id) => `'${id}'`).join(', ')}].includes(location.hash.slice(1))) location.replace('install.html' + location.hash);
</script>
<style>
${css}
.readme img { max-width: 100%; height: auto; }
.readme a { overflow-wrap: anywhere; }
.readme table { display: block; overflow-x: auto; }
.readme pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
.readme h1 { margin-top: 16px; }
nav.top { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 15px; }
.install { margin: 16px 0 8px; padding: 12px 16px; border: 1px solid var(--line); border-radius: 6px; }
.install p { margin: 0 0 8px; }
</style>
</head>
<body>
<main>
<nav class="top"><a href="install.html">Install, step by step</a><a href="${REPO}">Source on GitHub</a><a href="${REPO}/issues">Issues</a></nav>
<section class="install">
<p><strong>Install.</strong> Recommended: run the published image with Podman. <a href="install.html">The install
page</a> walks from nothing to a first finished job, on Linux or on Windows inside WSL. Or install it on this
machine with one line:</p>
<div class="cmd main-cmd"><pre>${escapeHtml(INSTALL)}</pre><button type="button" data-copy="${escapeHtml(INSTALL)}">Copy</button></div>
</section>
<article class="readme">
${body}</article>
<footer>hopper · <a href="${REPO}">source on GitHub</a> · <a href="install.html">install</a></footer>
</main>
<script>
document.querySelectorAll('[data-copy]').forEach((button) => {
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
      button.classList.add('done');
    } catch {
      button.textContent = 'Select and copy';
    }
    setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('done'); }, 2000);
  });
});
</script>
</body>
</html>
`;

// The install page's own styles, so both pages look alike.
const installCss = (install: string): string => /<style>\n([\s\S]*?)<\/style>/.exec(install)?.[1] ?? '';

export const buildPages = (root: string, out: string): void => {
  const install = readFileSync(join(root, 'site', 'install.html'), 'utf8');
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  writeFileSync(join(out, 'index.html'), page(renderReadme(readme), installCss(install).trimEnd()));
};

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write('usage: node scripts/build-pages.ts <site dir>\n');
    process.exit(2);
  }
  buildPages(join(import.meta.dirname, '..'), out);
}
