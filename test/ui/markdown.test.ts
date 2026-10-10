// @vitest-environment happy-dom
// Agent text as Markdown (issue #569, ui/src/lib/markdown.ts, ui/src/model/card-text.ts). What an agent writes renders
// with its headings, lists, emphasis, code, links and tables; it is never trusted: raw HTML and script in it show as
// text, no image loads, a link goes only to http(s), mailto or the UI and opens in a new tab with no opener and no
// referrer. A long text's summary is its first paragraph that is not a heading.
// The renderer is checked on its own: it is safe by its own rules. DOMPurify, the second layer, needs a browser's DOM
// (happy-dom lets HTML through it unchecked); the live check covers it in Chromium.
import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown, renderMarkdown } from '../../ui/src/lib/markdown.ts';
import { isLong, summaryOf, SUMMARY_CHARS } from '../../ui/src/model/card-text.ts';

const render = (text: string): HTMLElement => {
  const div = document.createElement('div');
  div.innerHTML = renderMarkdown(text);
  return div;
};

describe('Markdown rendering', () => {
  it('renders headings, lists, emphasis, code spans and blocks, links and tables', () => {
    const el = render([
      '## Options', '', '1. **Rebase** the branch', '2. *Merge* `dev` in', '', '- one', '- two', '',
      '```sh', 'npm test', '```', '', 'See [the issue](https://github.com/o/r/issues/1).', '',
      '| a | b |', '|---|---|', '| 1 | 2 |',
    ].join('\n'));
    expect(el.querySelector('h2')?.textContent).toBe('Options');
    expect(el.querySelectorAll('ol > li')).toHaveLength(2);
    expect(el.querySelector('ol strong')?.textContent).toBe('Rebase');
    expect(el.querySelector('ol em')?.textContent).toBe('Merge');
    expect(el.querySelector('li code')?.textContent).toBe('dev');
    expect(el.querySelectorAll('ul > li')).toHaveLength(2);
    expect(el.querySelector('pre code')?.textContent).toBe('npm test\n');
    expect(el.querySelector('table td')?.textContent).toBe('1');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('https://github.com/o/r/issues/1');
  });

  it('keeps a line break an agent wrote', () => {
    expect(render('Goal: one\nApproach: two').querySelector('br')).not.toBeNull();
  });

  it('shows raw HTML and script as text, escaped, and runs nothing', () => {
    const el = render('Before\n\n<script>window.pwned = 1</script>\n\nAn <b onclick="x()">inline</b> tag and <img src=x onerror="window.pwned=2">.');
    expect(el.querySelector('script, b, img, [onclick], [onerror]')).toBeNull();
    expect(el.textContent).toContain('<script>window.pwned = 1</script>');
    expect(el.textContent).toContain('<b onclick="x()">');
    expect(el.textContent).toContain('<img src=x onerror="window.pwned=2">');
    expect((window as { pwned?: number }).pwned).toBeUndefined();
  });

  it('loads no image: an image is a link to it, named by its alt text', () => {
    const el = render('![the chart](https://example.com/chart.png)');
    expect(el.querySelector('img')).toBeNull();
    const a = el.querySelector('a')!;
    expect(a.textContent).toBe('the chart');
    expect(a.getAttribute('href')).toBe('https://example.com/chart.png');
  });

  it('opens a link in a new tab, with no opener and no referrer', () => {
    const a = render('[docs](https://example.com/docs)').querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('drops a link to anything but http(s), mailto or the UI', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', '&#106;avascript:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'vbscript:x', '//evil.example']) {
      const el = render(`[click](${href}) ![pic](${href}) <${href}>`);
      expect(el.querySelector('a[href]:not([href^="http"])'), href).toBeNull();
      expect(el.textContent, href).toContain('click');
    }
    expect(render('[mail](mailto:a@example.com)').querySelector('a')!.getAttribute('href')).toBe('mailto:a@example.com');
    expect(render('[queue](#queue)').querySelector('a')!.getAttribute('href')).toBe('#queue');
  });

  it('renders one line inline only, with the same rules', () => {
    const span = document.createElement('span');
    span.innerHTML = renderInlineMarkdown('Use **rebase** <script>x()</script> [here](javascript:x())');
    expect(span.querySelector('p, script')).toBeNull();
    expect(span.querySelector('strong')?.textContent).toBe('rebase');
    expect(span.textContent).toContain('<script>x()</script>');
    expect(span.querySelector('a')?.getAttribute('href') ?? null).toBeNull();
  });
});

describe('summary of a long text', () => {
  it('is the first paragraph that is not a heading', () => {
    expect(summaryOf('## Question\n\nWhich branch do I rebase onto?\nIt matters for the release.\n\n## Context\n\nMore.'))
      .toBe('Which branch do I rebase onto?\nIt matters for the release.');
  });

  it('skips a code block before the first prose, and ends at one after it', () => {
    expect(summaryOf('```\nlog\n```\n\nThe build fails.')).toBe('The build fails.');
    expect(summaryOf('The build fails.\n```\nlog\n```')).toBe('The build fails.');
    expect(summaryOf('# Only\n```\ncode\n```')).toBe('');
  });

  it('is cut at a word, with an ellipsis, past its limit', () => {
    const s = summaryOf(`${'word '.repeat(200)}end`);
    expect(s.length).toBeLessThanOrEqual(SUMMARY_CHARS + 2);
    expect(s.endsWith(' …')).toBe(true);
    expect(s).not.toContain('wor …');
  });

  it('a text is long past 600 characters or 8 lines', () => {
    expect(isLong('short')).toBe(false);
    expect(isLong('x'.repeat(601))).toBe(true);
    expect(isLong(Array.from({ length: 9 }, (_, i) => `line ${i}`).join('\n'))).toBe(true);
  });
});
