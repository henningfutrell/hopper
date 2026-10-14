// The help pages (issue #782, design.md "Help"): the help book (src/help/book.ts) served twice from its one source.
//
//   GET /help/              the contents page, HTML        GET /help/<page>       a page, HTML
//   GET /help/<page>.md     a page's Markdown, as written  GET /help/index.json   every page: slug, title, summary, URLs
//
// A person reads the HTML: plain pages with no script, a contents list beside the text (above it on a phone), light or
// dark as the system is, the version of the running build at the foot. An agent reads the Markdown, and finds the pages
// in index.json; a job on a box reads the same through the help skill. Outside /api/, so readable without a session,
// like the API reference: the pages hold no user's data.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { HELP_PATH, helpBook, type HelpBook, type HelpPage } from '../help/book.ts';
import { API_REFERENCE_PATH } from './api-reference.ts';
import { FAVICON_LINK } from './static.ts';

/** No script, nothing from elsewhere: the page is its own text and its own style. */
const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const STYLE = `
:root{--bg:#fff;--fg:#1c1c1e;--muted:#6b6b70;--line:#e4e4e7;--accent:#2563eb;--code:#f4f4f5;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#111113;--fg:#ececee;--muted:#9a9aa1;--line:#2a2a2e;--accent:#7aa2ff;--code:#1c1c20;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:var(--accent)}.wrap{display:flex;gap:2rem;max-width:72rem;margin:0 auto;padding:1.5rem 1rem}
nav{flex:0 0 14rem;font-size:.9rem}nav ol{list-style:none;margin:0;padding:0}nav li{margin:.15rem 0}
nav a{display:block;padding:.25rem .5rem;border-radius:.375rem;text-decoration:none;color:var(--fg)}nav a[aria-current]{background:var(--code);font-weight:600}
nav .home{font-weight:700;margin-bottom:.5rem}main{flex:1;min-width:0;max-width:48rem}
h1{font-size:1.9rem;line-height:1.2;margin:.2rem 0 1rem}h2{margin-top:2rem;padding-top:.5rem;border-top:1px solid var(--line)}
code{background:var(--code);padding:.1rem .3rem;border-radius:.25rem;font-size:.9em}pre{background:var(--code);padding:.75rem 1rem;border-radius:.5rem;overflow-x:auto}
pre code{padding:0}table{border-collapse:collapse;display:block;overflow-x:auto;margin:1rem 0}th,td{border:1px solid var(--line);padding:.35rem .6rem;text-align:left;vertical-align:top}
blockquote{margin:1rem 0;padding:.1rem 1rem;border-left:3px solid var(--line);color:var(--muted)}
footer{margin-top:3rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.85rem}
@media (max-width:48rem){.wrap{flex-direction:column;gap:1rem}nav{flex:none;border-bottom:1px solid var(--line);padding-bottom:.75rem}
nav ol{display:flex;flex-wrap:wrap;gap:.25rem}nav li{margin:0}}`;

const escape = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const urlOf = (p: HelpPage): string => (p.slug === 'index' ? HELP_PATH : `${HELP_PATH}${p.slug}`);

/** One page, in the help's frame: the contents list, the text, the foot. */
export function helpHtml(book: HelpBook, page: HelpPage, version: string): string {
  const item = (p: HelpPage) => `<li><a href="${urlOf(p)}"${p === page ? ' aria-current="page"' : ''}>${escape(p.title)}</a></li>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(page.title)} · hopper help</title>${FAVICON_LINK}
<link rel="alternate" type="text/markdown" href="${HELP_PATH}${page.slug}.md">
<style>${STYLE}</style></head>
<body><div class="wrap">
<nav aria-label="Help pages"><div class="home"><a href="${HELP_PATH}"${page === book.index ? ' aria-current="page"' : ''}>hopper help</a></div><ol>${book.pages.map(item).join('')}</ol></nav>
<main>${page.html}
<footer>hopper ${escape(version)} · <a href="${HELP_PATH}${page.slug}.md">This page as Markdown</a> · <a href="${HELP_PATH}index.json">All pages for an agent</a> · <a href="${API_REFERENCE_PATH}/">API reference</a> · <a href="/">Back to the hopper</a></footer>
</main></div></body></html>`;
}

/** What an agent reads first: every page, what it is about, where its Markdown and its HTML are. */
export function helpIndex(book: HelpBook, version: string) {
  return {
    version,
    pages: book.pages.map((p) => ({ slug: p.slug, title: p.title, summary: p.summary, markdown: `${HELP_PATH}${p.slug}.md`, html: `${HELP_PATH}${p.slug}` })),
  };
}

export function helpRoutes(app: FastifyInstance, version: string): void {
  const html = (reply: FastifyReply, book: HelpBook, page: HelpPage) =>
    reply.type('text/html; charset=utf-8').header('content-security-policy', POLICY).header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-cache').send(helpHtml(book, page, version));
  app.get('/help', async (_req, reply) => reply.redirect(HELP_PATH, 301));
  app.get(HELP_PATH, async (_req, reply) => html(reply, helpBook(), helpBook().index));
  app.get<{ Params: { page: string } }>(`${HELP_PATH}:page`, async (req, reply) => {
    const book = helpBook();
    const { page } = req.params;
    if (page === 'index.json') return reply.header('cache-control', 'no-cache').send(helpIndex(book, version));
    const slug = page.endsWith('.md') ? page.slice(0, -3) : page;
    const found = book.pages.find((p) => p.slug === slug) ?? (slug === book.index.slug ? book.index : undefined);
    if (!found) return reply.code(404).send({ error: `no help page ${slug}: the pages are listed at ${HELP_PATH}index.json` });
    if (page.endsWith('.md')) return reply.type('text/markdown; charset=utf-8').header('cache-control', 'no-cache').send(found.markdown);
    return html(reply, book, found);
  });
}
