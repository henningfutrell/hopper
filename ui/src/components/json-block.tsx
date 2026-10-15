// A value as indented, highlighted JSON in a small code block, with copy (issue #1169): a job step's data, a decider
// decision's raw inputs, the built-in change rule.
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton, CodeBlockLine } from '@/components/ui/code-block';
import { useHighlightedCode } from '@/hooks/use-highlighted-code';

export function JsonBlock({ value, label, className }: { value: unknown; label: string; className?: string }) {
  const json = JSON.stringify(value, null, 2) ?? '';
  const lines = useHighlightedCode(json, 'json');
  return (
    <CodeBlock size="sm">
      <CodeBlockActions><CodeBlockCopyButton value={json} /></CodeBlockActions>
      <CodeBlockContent aria-label={label} className={className ?? 'max-h-72'}>
        {lines.map((line, i) => <CodeBlockLine key={i}>{line}</CodeBlockLine>)}
      </CodeBlockContent>
    </CodeBlock>
  );
}
