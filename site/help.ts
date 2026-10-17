// The help pages on the site (issue #790): help/*.md — the one source the daemon serves at /help/ (issue #782,
// src/help/book.ts) — rendered at build time into help/<page>.html in the site's look, with each page's Markdown beside
// it as written. The text is never copied into site/. The site imports nothing of src/, so this renders the pages
// itself, the same way the book does: the contents page's links are the order, a link to another page goes to that
// page here, and every heading gets the book's GitHub-style id (test/scripts/help-site.test.ts holds the two together).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Marked, type Token, type Tokens } from 'marked';

const CONTENTS = 'index';
/** A link to another help page: `vault.md`, `vault.md#vault-grants`. */
const PAGE_LINK = /^([a-z0-9][a-z0-9-]*)\.md(#[\w-]*)?$/;

export interface SiteHelpPage { slug: string; title: string; markdown: string; html: string }

/** A heading's id: lower case, words joined by `-`, as GitHub makes it — as the book makes it. */
const headingId = (text: string): string => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');

/** A wide table scrolls on its own, not the page (the site's `.table-wrap`). */
const scrollTables = (html: string): string => html.replaceAll('<table>', '<div class="table-wrap"><table>').replaceAll('</table>', '</table></div>');

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function renderer(): Marked {
  return new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }) {
        return `<h${depth} id="${headingId(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
    walkTokens(token) {
      if (token.type !== 'link') return;
      const m = PAGE_LINK.exec((token as Tokens.Link).href);
      if (m) (token as Tokens.Link).href = `${m[1] === CONTENTS ? 'index' : m[1]}.html${m[2] ?? ''}`;
    },
  });
}

/** The help pages, the contents page first, then in the order its links give; a page it does not link comes after. */
export function readHelp(dir: string): SiteHelpPage[] {
  const md = renderer();
  const slugs = readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort();
  const pages = new Map(slugs.map((slug) => {
    const markdown = readFileSync(join(dir, `${slug}.md`), 'utf8');
    const tokens = md.lexer(markdown);
    const title = tokens.find((t): t is Tokens.Heading => t.type === 'heading' && t.depth === 1)?.text ?? slug;
    return [slug, { slug, title, markdown, html: scrollTables(md.parse(markdown, { async: false })) }];
  }));
  const index = pages.get(CONTENTS);
  if (!index) throw new Error(`no help contents page: ${dir} has no ${CONTENTS}.md`);
  const linked: string[] = [];
  md.walkTokens(md.lexer(index.markdown), (t: Token) => {
    const m = t.type === 'link' ? PAGE_LINK.exec((t as Tokens.Link).href) : null;
    if (m && m[1] !== CONTENTS && pages.has(m[1]!) && !linked.includes(m[1]!)) linked.push(m[1]!);
  });
  return [index, ...linked.map((s) => pages.get(s)!), ...slugs.filter((s) => s !== CONTENTS && !linked.includes(s)).map((s) => pages.get(s)!)];
}

export interface HelpFrame {
  /** The site's stylesheet, as a help page links it (it sits one directory down). */
  stylesheet: string;
  version: string;
  /** The branch or tag the site is built from, for the link to a page's source; none when not known. */
  ref?: string;
}

const REPO = 'https://github.com/henningfutrell/hopper';

/** One help page in the site's frame: the site's header, the pages beside the text, the version at the foot. */
export function helpPageHtml(pages: SiteHelpPage[], page: SiteHelpPage, frame: HelpFrame): string {
  const [index, ...rest] = pages;
  const item = (p: SiteHelpPage) =>
    `<li><a href="${p.slug}.html"${p === page ? ' aria-current="page"' : ''} class="block rounded-md px-2 py-1 hover:bg-accent aria-[current]:bg-muted aria-[current]:font-semibold">${escape(p.title)}</a></li>`;
  const source = frame.ref ? ` · <a href="${REPO}/blob/${encodeURIComponent(frame.ref)}/help/${page.slug}.md" class="hover:text-foreground">Source on GitHub</a>` : '';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#121a26">
<title>${escape(page.title)} · hopper help</title>
<link rel="icon" type="image/svg+xml" href="../hopper-logo.svg">
<link rel="alternate" type="text/markdown" href="${page.slug}.md">
<script>
// Light or dark as the reader's system says, before the first paint.
(() => { const m = matchMedia('(prefers-color-scheme: dark)'); const set = () => document.documentElement.classList.toggle('dark', m.matches); set(); m.addEventListener('change', set); })();
</script>
<link rel="stylesheet" href="${frame.stylesheet}">
</head>
<body class="min-h-dvh bg-background text-foreground">
<a href="#main" class="sr-only z-50 rounded-md bg-background px-3 py-2 text-sm font-medium focus:not-sr-only focus:fixed focus:top-3 focus:left-3">Skip to content</a>
<header class="border-b border-border">
  <nav aria-label="Site" class="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4 sm:px-8">
    <a href="../" class="flex items-center gap-2.5 text-lg font-semibold tracking-tight"><img src="../hopper-logo.svg" alt="" width="21" height="32" class="h-7 w-auto">hopper</a>
    <ul class="flex items-center gap-1 text-sm font-medium text-muted-foreground sm:gap-2">
      <li><a href="../" class="rounded-md px-2.5 py-1.5 transition-colors hover:text-foreground">Home</a></li>
      <li><a href="../install.html" class="rounded-md px-2.5 py-1.5 transition-colors hover:text-foreground">Install</a></li>
      <li><a href="../guide.html" class="rounded-md px-2.5 py-1.5 transition-colors hover:text-foreground">Guide</a></li>
      <li><a href="./" class="rounded-md px-2.5 py-1.5 text-foreground transition-colors">Help</a></li>
    </ul>
  </nav>
</header>
<div class="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-8 pb-20 sm:px-8 md:flex-row md:gap-10">
<nav aria-label="Help pages" class="text-sm md:w-56 md:flex-none">
  <a href="index.html"${page === index ? ' aria-current="page"' : ''} class="mb-2 block px-2 font-semibold">hopper help</a>
  <ol class="flex flex-wrap gap-1 md:block">${rest.map(item).join('')}</ol>
</nav>
<main id="main" class="doc min-w-0 max-w-3xl flex-1">
${page.html}
<p class="note mt-12 border-t border-border pt-4">hopper ${escape(frame.version)}${frame.ref ? `, from ${escape(frame.ref)}` : ''}. A running hopper serves the help of its own version at <code>/help/</code>. · <a href="${page.slug}.md">This page as Markdown</a>${source} · <a href="${REPO}/blob/dev/LICENSE">MIT license</a></p>
</main>
</div>
</body>
</html>
`;
}
