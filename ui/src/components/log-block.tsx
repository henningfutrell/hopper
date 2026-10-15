// A log or a screen of output in a code block (issue #1169): a header with its title, a wrap toggle and copy, then its
// lines. The terminal and the event stream show their text in it.
import { WrapText } from 'lucide-react';
import { useState, type ReactNode, type Ref } from 'react';
import { Button } from '@/components/ui/button';
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block';
import { cn } from '@/lib/utils';

export function LogBlock({ title, copy, lineNumbers = false, wrap: wrapFirst = false, contentRef, className, contentClassName, children }: {
  title: ReactNode;
  /** The text Copy puts on the clipboard. */
  copy: string;
  lineNumbers?: boolean;
  /** Whether long lines wrap at first; the toggle changes it. */
  wrap?: boolean;
  contentRef?: Ref<HTMLPreElement>;
  className?: string;
  contentClassName?: string;
  /** The lines: a string, or CodeBlockLine elements. */
  children: ReactNode;
}) {
  const [wrap, setWrap] = useState(wrapFirst);
  return (
    <CodeBlock className={className}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <Button variant="ghost" size="icon-xs" aria-label="Wrap long lines" aria-pressed={wrap} title="Wrap long lines"
            className={cn(wrap && 'text-foreground')} onClick={() => setWrap(!wrap)}><WrapText /></Button>
          <CodeBlockCopyButton value={copy} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent ref={contentRef} wrap={wrap} lineNumbers={lineNumbers} aria-label={typeof title === 'string' ? title : undefined}
        className={contentClassName}>
        {children}
      </CodeBlockContent>
    </CodeBlock>
  );
}
