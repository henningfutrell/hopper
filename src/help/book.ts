// The help book (issue #782, design.md "Help"): the help pages, one Markdown file each under help/ at the repo root —
// the one source both readers read. A person reads them as HTML (src/http/help.ts), an agent as the Markdown itself, at
// /help/<page>.md or through the help skill. The contents page, help/index.md, orders the pages by its links to them;
// a page it does not link, or a link to a page that is not there, is a problem (a test keeps the shipped pages free of
// them; the daemon only warns). Read once per process: the pages are part of the build, like the UI.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Marked, type Token, type Tokens } from 'marked';

/** The help pages this build ships. */
export const HELP_DIR = fileURLToPath(new URL('../../help/', import.meta.url));
/** Where a person reads the help; a page is `/help/<slug>`, its Markdown `/help/<slug>.md`. */
export const HELP_PATH = '/help/';
const CONTENTS = 'index';
/** A link to another help page: `vault.md`, `vault.md#vault-grants`. */
const PAGE_LINK = /^([a-z0-9][a-z0-9-]*)\.md(#[\w-]*)?$/;

export interface HelpPage {
  slug: string;
  title: string;
  /** The page's first paragraph, as plain text: what the contents and the agent's list say of it. */
  summary: string;
  markdown: string;
  /** The page rendered: links to other pages go to their help URL; every heading has an id. */
  html: string;
}

export interface HelpBook {
  /** The contents page. */
  index: HelpPage;
  /** Every other page, in the contents page's order; a page it does not link comes after, by name. */
  pages: HelpPage[];
  problems: string[];
}

/** A heading's id: lower case, words joined by `-`, as GitHub makes it. */
export const headingId = (text: string): string => text.toLowerCase().replace(/<[^>]*>/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s/g, '-');

const plain = (text: string): string => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();

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
      if (m) (token as Tokens.Link).href = `${HELP_PATH}${m[1] === CONTENTS ? '' : m[1]}${m[2] ?? ''}`;
    },
  });
}

function read(dir: string, slug: string, md: Marked): HelpPage & { links: string[] } {
  const markdown = readFileSync(join(dir, `${slug}.md`), 'utf8');
  const tokens = md.lexer(markdown);
  const links: string[] = [];
  md.walkTokens(tokens, (t: Token) => {
    if (t.type === 'link') links.push((t as Tokens.Link).href);
  });
  const title = tokens.find((t): t is Tokens.Heading => t.type === 'heading' && t.depth === 1)?.text ?? slug;
  const summary = plain(tokens.find((t): t is Tokens.Paragraph => t.type === 'paragraph')?.text ?? '');
  // The links are read before walkTokens rewrites them: parse lexes again.
  return { slug, title, summary, markdown, html: md.parse(markdown, { async: false }), links };
}

export function loadHelpBook(dir: string = HELP_DIR): HelpBook {
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
  if (!files.includes(CONTENTS)) {
    return { index: { slug: CONTENTS, title: 'Help', summary: '', markdown: '', html: '' }, pages: [], problems: [`no help pages: ${dir} has no ${CONTENTS}.md`] };
  }
  const md = renderer();
  const all = new Map(files.map((slug) => [slug, read(dir, slug, md)]));
  const problems: string[] = [];
  for (const page of all.values()) {
    for (const href of page.links) {
      const m = PAGE_LINK.exec(href);
      if (m && !all.has(m[1]!)) problems.push(`${page.slug}.md links ${m[1]}.md, which is not there`);
    }
  }
  const listed = [...new Set(all.get(CONTENTS)!.links.flatMap((h) => PAGE_LINK.exec(h)?.[1] ?? []))].filter((s) => all.has(s) && s !== CONTENTS);
  const unlisted = files.filter((s) => s !== CONTENTS && !listed.includes(s));
  for (const s of unlisted) problems.push(`${s}.md is not on the contents page (${CONTENTS}.md)`);
  const strip = ({ links: _l, ...p }: HelpPage & { links: string[] }): HelpPage => p;
  return { index: strip(all.get(CONTENTS)!), pages: [...listed, ...unlisted].map((s) => strip(all.get(s)!)), problems };
}

let shipped: HelpBook | undefined;
/** The help this build ships, read on first use. */
export function helpBook(): HelpBook {
  if (shipped) return shipped;
  shipped = loadHelpBook(HELP_DIR);
  for (const p of shipped.problems) console.warn(`hopper: help: ${p}`);
  return shipped;
}

/** The help skill's answer (src/skills): with no page, the list of pages; with one, its Markdown; else why not. */
export function helpForAgent(page: string | undefined, book: HelpBook = helpBook()): { text: string } | { no: string } {
  if (!page) {
    const list = book.pages.map((p) => `${p.slug}: ${p.title} — ${p.summary}`).join('\n');
    return { text: `The hopper's help pages, for this version:\n${list}\nRead one: sh "$HOPPER_SKILL" help PAGE` };
  }
  const found = book.pages.find((p) => p.slug === page) ?? (page === CONTENTS ? book.index : undefined);
  return found ? { text: found.markdown.trim() } : { no: `the help has no page ${page}. It has: ${book.pages.map((p) => p.slug).join(', ')}.` };
}
