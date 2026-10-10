// An artifact's revisions (issue #675): every change is one. The list, newest first — its number, when, who made it and
// its note —; open any one (#artifacts/<id>/<n> pins it), restore an older one as the latest (nothing is overwritten),
// pin one so the retention sweep keeps it, copy a link that pins it. Restore and pin are the owner's.
import { Copy, Pin, PinOff, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Since } from '@/components/job';
import { Button } from '@/components/ui/button';
import { byInWords, bytesInWords, revisionHash } from '@/model/artifacts';
import type { ArtifactRevisionView, ArtifactView } from '@/model/wire';
import { pinRevision, readRevisions, restoreRevision } from '@/store/artifacts';
import { cn } from '@/lib/utils';

/** The revisions of `a`, read again whenever it has a new one, and on `reload`. */
export function useRevisions(a: ArtifactView): [ArtifactRevisionView[] | null, () => void] {
  const [revs, setRevs] = useState<ArtifactRevisionView[] | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let live = true;
    void readRevisions(a.id).then((r) => { if (live) setRevs(r); });
    return () => { live = false; };
  }, [a.id, a.revision, asked]);
  return [revs, () => setAsked((n) => n + 1)];
}

export function Revisions({ a, revs, open, reload }: { a: ArtifactView; revs: ArtifactRevisionView[] | null; open: number; reload: () => void }) {
  const owner = !a.owner;
  const copy = (n: number) => { void navigator.clipboard?.writeText(`${a.url}/${n}`).then(() => toast.success('Copied a link to this revision'), () => {}); };
  return (
    <div data-slot="artifact-revisions" className="space-y-2 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">Revisions</h3>
      {revs === null && <p className="text-xs text-muted-foreground">Could not read the revisions.</p>}
      <ol className="space-y-1">
        {(revs ?? []).map((r) => (
          <li key={r.n} data-revision={r.n} className={cn('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-1 text-xs', r.n === open && 'border-foreground/20 bg-muted')}>
            <a href={revisionHash(a.id, r.latest ? undefined : r.n)} className="font-medium hover:underline">
              {r.n}{r.latest ? ' · latest' : ''}
            </a>
            <Since iso={r.createdAt} className="text-muted-foreground" />
            <span className="text-muted-foreground">{byInWords(r.by)}</span>
            <span className="text-muted-foreground">{bytesInWords(r.size)}</span>
            {r.pinned && <span className="rounded border px-1 text-[10px]">pinned</span>}
            {r.note && <span className="min-w-0 basis-full truncate sm:basis-auto sm:flex-1">{r.note}</span>}
            <span className="ml-auto flex gap-1">
              <Button size="xs" variant="ghost" onClick={() => copy(r.n)} aria-label={`Copy a link to revision ${r.n}`}><Copy /></Button>
              {owner && (
                <Button size="xs" variant="ghost" onClick={() => void pinRevision(a.id, r.n, !r.pinned).then(reload)} aria-label={`${r.pinned ? 'Unpin' : 'Pin'} revision ${r.n}`}>
                  {r.pinned ? <PinOff /> : <Pin />}
                </Button>
              )}
              {owner && !r.latest && (
                <Button size="xs" variant="ghost" onClick={() => void restoreRevision(a.id, r.n).then((x) => { if (x) location.hash = revisionHash(a.id); })}>
                  <RotateCcw />Restore
                </Button>
              )}
            </span>
          </li>
        ))}
      </ol>
      {owner && <p className="text-xs text-muted-foreground">Restore makes a revision the latest, as a new one. A pinned revision is kept past the retention.</p>}
    </div>
  );
}
