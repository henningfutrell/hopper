// Agent text on a card, as Markdown (issue #569): rendered and sanitized by `@/lib/markdown`, styled by `.md` in
// index.css. A long text shows its TL;DR — plain text a cheap model wrote, never rendered as HTML — or else its
// summary first, the rest behind Show all, so a card stays compact.
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { inlineMarkdownHtml, markdownHtml } from '@/lib/markdown';
import { isLong, summaryOf } from '@/model/card-text';
import { cn } from '@/lib/utils';

/** `text` rendered as Markdown, whole. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => markdownHtml(text), [text]);
  return <div data-slot="markdown" className={cn('md', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** One line of `text`, its inline Markdown only: for a line that is cut short. */
export function InlineMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => inlineMarkdownHtml(text), [text]);
  return <span data-slot="inline-markdown" className={cn('md-inline', className)} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Show all / Show less, under a folded text. */
export function FoldToggle({ open, onToggle, lines }: { open: boolean; onToggle: () => void; lines?: number }) {
  return (
    <button type="button" data-slot="fold" aria-expanded={open} onClick={onToggle}
      className="group flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
      <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      {open ? 'Show less' : `Show all${lines ? ` (${lines} lines)` : ''}`}
    </button>
  );
}

/** A card's TL;DR (issue #569): plain text, shown as text — HTML in it is never markup. */
export function TldrLine({ text }: { text: string }) {
  return (
    <p data-slot="tldr" className="text-sm">
      <span className="mr-1.5 rounded bg-muted px-1 py-0.5 align-[1px] text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">TL;DR</span>
      {text}
    </p>
  );
}

/**
 * An agent's text on a card: whole when short; else its TL;DR when it has one, or its summary, and the whole text
 * behind Show all.
 */
export function CardText({ text, className, tldr }: { text: string; className?: string; tldr?: string | undefined }) {
  const [open, setOpen] = useState(false);
  const long = isLong(text);
  const summary = useMemo(() => (long ? summaryOf(text) : ''), [long, text]);
  const toggle = <FoldToggle open={open} onToggle={() => setOpen((o) => !o)} lines={text.trim().split('\n').length} />;
  if (long && tldr) {
    return (
      <div data-slot="card-text" data-open={open ? '' : undefined} className="space-y-1.5">
        <TldrLine text={tldr} />
        {open && <Markdown text={text} className={className} />}
        {toggle}
      </div>
    );
  }
  if (!long || !summary) return <Markdown text={text} className={className} />;
  return (
    <div data-slot="card-text" data-open={open ? '' : undefined} className="space-y-1.5">
      <Markdown text={open ? text : summary} className={className} />
      {toggle}
    </div>
  );
}
