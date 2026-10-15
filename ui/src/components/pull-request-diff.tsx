// A pull request's diff on its card (issue #1169): Show diff reads it through the hopper (POST /ui/api/pull-requests/diff,
// the person's own GitHub connection) and shows it in a code block in diff mode, with copy and a wrap toggle. An operator's;
// a viewer is not offered it.
import { FileDiff } from 'lucide-react';
import { useState } from 'react';
import { LogBlock } from '@/components/log-block';
import { Button } from '@/components/ui/button';
import { CodeBlockLine } from '@/components/ui/code-block';
import { post } from '@/lib/api';
import { diffLinesOf, diffSummary, type DiffLineKind } from '@/model/pull-request-diff';
import type { PullRequestDiff as Diff } from '@/model/wire';
import { useCanOperate } from '@/store/selectors';

const VARIANT: Record<DiffLineKind, 'default' | 'added' | 'removed' | 'highlighted'> = { file: 'highlighted', hunk: 'highlighted', added: 'added', removed: 'removed', same: 'default' };

function DiffBlock({ d }: { d: Diff }) {
  return (
    <LogBlock title={`#${d.number}: ${diffSummary(d)}`} copy={d.diff} contentClassName="max-h-96">
      {diffLinesOf(d.diff).map((l, i) => (
        <CodeBlockLine key={i} data-change={l.kind} variant={VARIANT[l.kind]}
          className={l.kind === 'file' ? 'font-medium' : l.kind === 'hunk' ? 'text-muted-foreground' : undefined}>
          {l.text}
        </CodeBlockLine>
      ))}
    </LogBlock>
  );
}

export function PullRequestDiff({ repo, number }: { repo: string; number: number }) {
  const operator = useCanOperate();
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState<Diff | undefined>();
  const [error, setError] = useState<string | undefined>();
  if (!operator) return null;
  const toggle = () => {
    setOpen(!open);
    if (open || read) return;
    setError(undefined);
    post<Diff>('/ui/api/pull-requests/diff', { repo, number }).then(setRead, (e: unknown) => setError((e as Error).message));
  };
  return (
    <div className="w-full space-y-1">
      <Button data-slot="pr-diff-toggle" size="xs" variant="ghost" aria-expanded={open} onClick={toggle}><FileDiff />{open ? 'Hide diff' : 'Show diff'}</Button>
      {open && (
        <div data-slot="pr-diff" aria-label={`The diff of #${number}`}>
          {read ? <DiffBlock d={read} />
            : error ? <div data-slot="pr-diff-error" className="text-xs text-bad">{error}</div>
              : <div className="text-xs text-muted-foreground">reading the diff…</div>}
        </div>
      )}
    </div>
  );
}
