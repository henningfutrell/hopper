// Agent text as Markdown (issue #569): the HTML a card shows for what an agent wrote — a question, a proposal, a
// research report, a note. The text comes from agents and, through issues, from people the hopper does not know, so it
// is never trusted. Two layers, each enough alone:
// - the renderer (marked) makes only safe HTML: raw HTML in the text shows as text (escaped, never run), no image
//   loads (an image is a link to it), a link goes only to http(s), mailto or the UI and opens in a new tab with no
//   opener and no referrer — anything else is its text, no link;
// - DOMPurify then keeps only the tags and attributes below, and those link rules again.
// The renderer is tested on its own (test/ui/markdown.test.ts): DOMPurify needs a real browser DOM, and passes HTML
// through unchecked in happy-dom.
import DOMPurify, { type Config, type DOMPurify as Purifier } from 'dompurify';
import { Marked, type Tokens } from 'marked';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** Where a link may go: the web, mail, or a view of the UI. */
const LINKABLE = /^(?:https?:|mailto:|#)/i;
const NEW_TAB = 'target="_blank" rel="noopener noreferrer"';
const anchor = (href: string, title: string | null | undefined, inner: string): string =>
  `<a href="${escape(href)}"${title ? ` title="${escape(title)}"` : ''} ${NEW_TAB}>${inner}</a>`;

const marked = new Marked({
  gfm: true,
  // An agent's line break is a line break, as the plain text showed it.
  breaks: true,
  renderer: {
    // Raw HTML is shown as the text it is.
    html: (t: Tokens.HTML | Tokens.Tag) => ('block' in t && t.block ? `<p>${escape(t.text)}</p>` : escape(t.text)),
    link(t: Tokens.Link) {
      const inner = this.parser.parseInline(t.tokens);
      return LINKABLE.test(t.href.trim()) ? anchor(t.href.trim(), t.title, inner) : inner;
    },
    // An image is never loaded: a link to it, named by its alt text.
    image: (t: Tokens.Image) => (LINKABLE.test(t.href.trim()) ? anchor(t.href.trim(), t.title, escape(t.text || t.href)) : escape(t.text)),
    // A task list item's box as a character: no form input in a card.
    checkbox: (t: Tokens.Checkbox) => (t.checked ? '☑ ' : '☐ '),
  },
});

/** `text` rendered block by block, safe by the renderer's own rules. */
export const renderMarkdown = (text: string): string => marked.parse(text, { async: false });

/** One line of `text`, its inline Markdown only, safe by the renderer's own rules. */
export const renderInlineMarkdown = (text: string): string => marked.parseInline(text, { async: false });

const CONFIG: Config = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
  ALLOWED_ATTR: ['href', 'title', 'start', 'align', 'target', 'rel'],
  ALLOWED_URI_REGEXP: LINKABLE,
  ALLOW_DATA_ATTR: false,
};

let purifier: Purifier | undefined;
/** One sanitizer for the UI, made at first use: every link it keeps opens in a new tab, with no opener and no referrer. */
function purify(): Purifier {
  if (purifier) return purifier;
  const p = DOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName !== 'A') return;
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  });
  purifier = p;
  return p;
}

/** `text` as the HTML a card shows: rendered, then sanitized. */
export const markdownHtml = (text: string): string => purify().sanitize(renderMarkdown(text), CONFIG);

/** One line of `text` as the HTML a card shows: its inline Markdown, rendered, then sanitized. */
export const inlineMarkdownHtml = (text: string): string => purify().sanitize(renderInlineMarkdown(text), CONFIG);
