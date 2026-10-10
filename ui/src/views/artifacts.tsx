// Artifacts (issue #624): what the user's jobs made for a person to see, and what other users shared with them. The
// list, newest first; the one the hash names (#artifacts/<id>, an artifact's stable URL) opens beside it with its
// preview, its job and issue, and — for its owner — its shares: with another user of the hopper, or a public link that
// expires. A public link is shown once, when it is made. HTML opens only in a sandbox.
import { Copy, Download, ExternalLink, FolderOpen, Link2, Trash2, UserPlus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useSection } from '@/app/nav';
import { ArtifactPreview } from '@/components/artifacts';
import { GhLink, Since } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useNow } from '@/hooks/use-now';
import { bytesInWords, findArtifact, liveShare, shareInWords } from '@/model/artifacts';
import type { ArtifactView } from '@/model/wire';
import { refreshArtifacts, removeArtifact, revokeShare, shareLink, shareWithUser, useArtifacts } from '@/store/artifacts';
import { cn } from '@/lib/utils';

function Row({ a, open }: { a: ArtifactView; open: boolean }) {
  return (
    <a href={open ? '#artifacts' : `#artifacts/${a.id}`} aria-current={open ? 'true' : undefined} data-artifact={a.id}
      className={cn('flex items-center gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/60', open && 'border-foreground/20 bg-muted')}>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{a.title}</span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {a.name} · {a.kind} · {bytesInWords(a.size)}{a.owner ? ` · from ${a.owner}` : ''}{a.issue ? ` · ${a.issue.ref}` : ''}
        </span>
      </span>
      <Since iso={a.createdAt} className="shrink-0 text-xs text-muted-foreground" />
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

function Detail({ a }: { a: ArtifactView }) {
  const remove = () => { if (window.confirm(`Remove ${a.title}? Its shares stop working.`)) void removeArtifact(a.id).then(() => { location.hash = '#artifacts'; }); };
  return (
    <Panel title={a.title} action={<a href="#artifacts" aria-label="Close" className="text-muted-foreground hover:text-foreground"><X className="size-4" /></a>}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{a.name}</span><span>{a.type}</span><span>{bytesInWords(a.size)}</span>
          <span>job {a.jobId.slice(0, 8)}</span>
          {a.issue && <GhLink url={a.issue.url}>{a.issue.ref}<ExternalLink className="size-3" /></GhLink>}
          {a.owner && <span>shared by {a.owner}</span>}
          <span className="font-mono" title="SHA-256">{a.sha256.slice(0, 12)}</span>
        </div>
        <ArtifactPreview artifact={a} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><a href={a.contentUrl} target="_blank" rel="noopener noreferrer"><ExternalLink />Open</a></Button>
          <Button size="sm" variant="outline" asChild><a href={`${a.contentUrl}&download=1`}><Download />Download</a></Button>
          <Button size="sm" variant="outline" onClick={() => { void navigator.clipboard?.writeText(a.url).then(() => toast.success('Copied'), () => {}); }}><Copy />Copy its URL</Button>
          {!a.owner && <Button size="sm" variant="outline" onClick={remove}><Trash2 />Remove</Button>}
        </div>
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
            ? <Empty>No artifacts yet. A job puts one with hopper-artifact put FILE.</Empty>
            : <div className="grid gap-1.5">{view.artifacts.map((a) => <Row key={a.id} a={a} open={a.id === id} />)}</div>}
          <p className="mt-2 text-xs text-muted-foreground">{bytesInWords(view.usedBytes)} of {bytesInWords(view.settings.userBytes)} used.</p>
        </Panel>
        {view.shared.length > 0 && (
          <Panel title="Shared with you" icon={UserPlus} count={view.shared.length} list>
            <div className="grid gap-1.5">{view.shared.map((a) => <Row key={a.id} a={a} open={a.id === id} />)}</div>
          </Panel>
        )}
      </div>
      {open ? <Detail key={open.id} a={open} />
        : id ? <Panel title="Artifact"><Empty>No artifact {id} of yours or shared with you. It was removed, or its share was revoked.</Empty></Panel>
          : null}
    </div>
  );
}
