// A job's issue lineage on its card (issue #729): the parent its issue is a child of, and its children — each a required
// child or a follow-up a job filed through the hopper —, with its descendants in all on hover.
import { useMemo } from 'react';
import { lineageOf, type LineageIssue } from '@/model/lineage';
import type { Job } from '@/model/wire';
import { useLineage } from '@/store/lineage';
import { GhLink } from './job';

const kind = (i: LineageIssue): string => (i.required ? 'required' : 'follow-up');

export function LineageChips({ job }: { job: Job }) {
  const links = useLineage((s) => s.links);
  const lineage = useMemo(() => lineageOf(links, job.source?.repo, job.source?.number ?? undefined), [links, job.source?.repo, job.source?.number]);
  if (!lineage) return null;
  const { parent, children, descendants } = lineage;
  const required = children.filter((c) => c.required).length;
  return (
    <>
      {parent && (
        <GhLink url={parent.url} className="rounded border px-1 text-[10px] no-underline">
          <span data-lineage-parent={parent.ref}
            title={parent.required ? `Its issue is a required child of ${parent.ref}: ${parent.ref} is not done while it is open` : `Its issue is a follow-up of ${parent.ref}`}>
            {parent.required ? `required by ${parent.ref}` : `child of ${parent.ref}`}
          </span>
        </GhLink>
      )}
      {children.length > 0 && (
        <span data-lineage-children={children.length} className="rounded border px-1 text-[10px]"
          title={[`Children of its issue:`, ...children.map((c) => `${c.ref} (${kind(c)})`), `Descendants in all: ${descendants}`].join('\n')}>
          {`children ${children.length}${required > 0 ? `, ${required} required` : ''}`}
        </span>
      )}
    </>
  );
}
