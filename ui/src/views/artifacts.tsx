// Artifacts (issue #624): how the user's jobs present their work — live pages with flowcharts, charts and interactive
// views (issue #675) —, and what other users shared with them. The list, newest first, each with its title and summary;
// the one the hash names (#artifacts/<id>, an artifact's stable URL, which follows its latest revision; #artifacts/<id>/<n>
// pins revision n) opens beside it with its preview, its job and issue, its revisions, and — for its owner — its shares:
// with another user of the hopper, or a public link that expires, and a merge of another of their artifacts into it
// (issue #687). A public link is shown once, when it is made. HTML opens only in a sandbox.
import { Copy, Download, ExternalLink, FolderOpen, Link2, Merge, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { toast } from 'sonner';
import { useSection } from '@/app/nav';
import { ArtifactPreview } from '@/components/artifacts';
import { GhLink, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNow } from '@/hooks/use-now';
import { bytesInWords, findArtifact, liveShare, revisionHash, revisionOfHash, shareInWords } from '@/model/artifacts';
import type { ArtifactView } from '@/model/wire';
import { mergeArtifacts, refreshArtifacts, removeArtifact, revokeShare, shareLink, shareWithUser, useArtifacts } from '@/store/artifacts';
import { cn } from '@/lib/utils';
import { Revisions, useRevisions } from './artifact-revisions';

const onHash = (fn: () => void) => { window.addEventListener('hashchange', fn); return () => window.removeEventListener('hashchange', fn); };
/** The revision the hash pins, or undefined: the latest. */
const usePinnedRevision = (): number | undefined => useSyncExternalStore(onHash, () => revisionOfHash(window.location.hash));

function Row({ a, open }: { a: ArtifactView; open: boolean }) {
  return (
    <a href={open ? '#artifacts' : `#artifacts/${a.id}`} aria-current={open ? 'true' : undefined} data-artifact={a.id}
      className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/60', open && 'border-foreground/20 bg-muted')}>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.title}</span>
        {a.summary && <span className="block truncate text-xs text-muted-foreground">{a.summary}</span>}
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {a.kind} · {bytesInWords(a.size)}{a.revision > 1 ? ` · revision ${a.revision}` : ''}{a.owner ? ` · from ${a.owner}` : ''}{a.issue ? ` · ${a.issue.ref}` : ''}
        </span>
      </span>
      <Since iso={a.updatedAt} className="shrink-0 text-xs text-muted-foreground" />
    </a>
  );
}

function Shares({ a }: { a: ArtifactView }) {
  const now = useNow();
  const [user, setUser] = useState('');
  const [hours, setHours] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const shares = a.shares ?? [];
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => {}); };
  return (
    <div data-slot="artifact-shares" className="space-y-2 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">Shared with</h3>
      {shares.length === 0 && <p className="text-xs text-muted-foreground">Nobody. Only you see it.</p>}
      <ul className="space-y-1">
        {shares.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-xs">
            <span className={cn(!liveShare(s, now) && 'text-muted-foreground line-through')}>{shareInWords(s, now)}</span>
            {liveShare(s, now) && <Button size="xs" variant="ghost" onClick={() => void revokeShare(a.id, s.id)} aria-label={`Revoke ${shareInWords(s, now)}`}><X />Revoke</Button>}
          </li>
        ))}
      </ul>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); if (user.trim()) void shareWithUser(a.id, user.trim()).then((r) => { if (r) setUser(''); }); }}>
        <Input value={user} onChange={(e) => setUser(e.target.value)} placeholder="a user's name" aria-label="Share with the user named" className="h-8 w-48" />
        <Button size="sm" type="submit" variant="outline" disabled={!user.trim()}><UserPlus />Share</Button>
      </form>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
        e.preventDefault();
        void shareLink(a.id, hours ? Number(hours) : undefined).then((r) => { if (r) setLink(r.link); });
      }}>
        <Input value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ''))} placeholder="hours (default)" aria-label="Hours the public link works" className="h-8 w-36" />
        <Button size="sm" type="submit" variant="outline"><Link2 />Make a public link</Button>
      </form>
      {link && (
        <p data-slot="artifact-link" className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs">
          <span className="min-w-0 flex-1 truncate font-mono">{link}</span>
          <Button size="xs" variant="ghost" onClick={() => copy(link)}><Copy />Copy</Button>
        </p>
      )}
      {link && <p className="text-xs text-muted-foreground">The link is shown only now. Anybody who has it sees the artifact until it expires or you revoke it.</p>}
    </div>
  );
}

/** Issue #687: another of the owner's artifacts merged into this one — its revisions added, oldest first; then it goes. */
function MergeInto({ a, mine }: { a: ArtifactView; mine: ArtifactView[] }) {
  const others = mine.filter((x) => x.id !== a.id);
  const [from, setFrom] = useState('');
  if (others.length === 0) return null;
  const merge = () => {
    const src = others.find((x) => x.id === from);
    if (!src || !window.confirm(`Merge ${src.title} into ${a.title}? Its ${src.revision} revision${src.revision > 1 ? 's' : ''} are added here, oldest first, and it is removed.`)) return;
    void mergeArtifacts(a.id, [src.id]).then((r) => { if (r) setFrom(''); });
  };
  return (
    <div data-slot="artifact-merge" className="space-y-2 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">Merge into this</h3>
      <div className="flex flex-wrap items-center gap-2">
        <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="The artifact to merge into this one"
          className="h-8 min-w-0 max-w-full flex-1 rounded-md border bg-background px-2 text-xs">
          <option value="">Choose an artifact…</option>
          {others.map((x) => <option key={x.id} value={x.id}>{x.title} · revision {x.revision}</option>)}
        </select>
        <Button size="sm" variant="outline" disabled={!from} onClick={merge}><Merge />Merge</Button>
      </div>
      <p className="text-xs text-muted-foreground">Its revisions become revisions of this artifact, and the newest is the latest. Then it is removed.</p>
    </div>
  );
}

function Detail({ a, mine }: { a: ArtifactView; mine: ArtifactView[] }) {
  const remove = () => { if (window.confirm(`Remove ${a.title}? Every revision goes, and its shares stop working.`)) void removeArtifact(a.id).then(() => { location.hash = '#artifacts'; }); };
  const [revs, reload] = useRevisions(a);
  const pinned = usePinnedRevision();
  // A pinned revision that is not the latest: its own content, title and summary; the latest otherwise.
  const old = pinned !== undefined && pinned !== a.revision ? revs?.find((r) => r.n === pinned) : undefined;
  const shown = old ?? a;
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => toast.success('Copied'), () => {}); };
  return (
    <Panel title={shown.title} action={<a href="#artifacts" aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></a>}>
      <div className="space-y-3">
        {shown.summary && <p data-slot="artifact-summary" className="text-sm">{shown.summary}</p>}
        {old && (
          <p data-slot="artifact-old-revision" className="rounded-md border bg-muted/40 px-2 py-1 text-xs">
            Revision {old.n} of {a.revision}. <a className="underline" href={revisionHash(a.id)}>Open the latest</a>
          </p>
        )}
        {pinned !== undefined && pinned !== a.revision && revs && !old && (
          <p className="rounded-md border px-2 py-1 text-xs text-muted-foreground">No revision {pinned}: the retention removed it. This is the latest.</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{shown.name}</span><span>{shown.type}</span><span>{bytesInWords(shown.size)}</span>
          <span>revision {old ? old.n : a.revision}</span>
          <span>job {a.jobId.slice(0, 8)}</span>
          {a.issue && <GhLink url={a.issue.url}>{a.issue.ref}<ExternalLink className="size-3" /></GhLink>}
          {a.owner && <span>shared by {a.owner}</span>}
          <span className="font-mono" title="SHA-256">{shown.sha256.slice(0, 12)}</span>
        </div>
        <ArtifactPreview key={shown.contentUrl} artifact={shown} height={520} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><a href={shown.contentUrl} target="_blank" rel="noopener noreferrer"><ExternalLink />Open</a></Button>
          <Button size="sm" variant="outline" asChild><a href={`${shown.contentUrl}&download=1`}><Download />Download</a></Button>
          <Button size="sm" variant="outline" onClick={() => copy(a.url)}><Copy />Copy its URL</Button>
          {old && <Button size="sm" variant="outline" onClick={() => copy(`${a.url}/${old.n}`)}><Copy />Copy a link to revision {old.n}</Button>}
          {!a.owner && <Button size="sm" variant="outline" onClick={remove}><Trash2 />Remove</Button>}
        </div>
        <Revisions a={a} revs={revs} open={old ? old.n : a.revision} reload={reload} />
        {!a.owner && <MergeInto a={a} mine={mine} />}
        {!a.owner && <Shares a={a} />}
      </div>
    </Panel>
  );
}

export function Artifacts() {
  const view = useArtifacts((s) => s.view);
  const error = useArtifacts((s) => s.error);
  const id = useSection();
  useEffect(() => { void refreshArtifacts(); }, []);
  const open = id ? findArtifact(view, id) : undefined;
  if (!view) return <p className="text-sm text-muted-foreground">{error ? `Could not read the artifacts: ${error}` : 'Loading…'}</p>;
  return (
    <div className="grid gap-3 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
      <div className="space-y-3">
        <Panel title="Artifacts" icon={FolderOpen} count={view.artifacts.length} list>
          {view.artifacts.length === 0
            ? <Empty>No artifacts yet. An artifact is how a job presents its work: a live page with flowcharts, charts or interactive views, which you open, use and share. A job puts one with hopper-artifact put FILE.</Empty>
            : <div className="grid gap-1.5">{view.artifacts.map((a) => <Row key={a.id} a={a} open={a.id === id} />)}</div>}
          <p className="mt-2 text-xs text-muted-foreground">{bytesInWords(view.usedBytes)} of {bytesInWords(view.settings.userBytes)} used.</p>
        </Panel>
        {view.shared.length > 0 && (
          <Panel title="Shared with you" icon={UserPlus} count={view.shared.length} list>
            <div className="grid gap-1.5">{view.shared.map((a) => <Row key={a.id} a={a} open={a.id === id} />)}</div>
          </Panel>
        )}
      </div>
      {open ? <Detail key={open.id} a={open} mine={view.artifacts} />
        : id ? <Panel title="Artifact"><Empty>No artifact {id} of yours or shared with you. It was removed, or its share was revoked.</Empty></Panel>
          : null}
    </div>
  );
}
