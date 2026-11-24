// Settings → Search (issue #2990), the hopper's admin's: which Solr search uses, where the credentials it sends come from,
// and the pair the hopper's vault keeps when the launch gives none — set here, checked once against Solr, or removed. The
// password field is never filled in: the hopper never shows the username or the password again.
import { Search, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { solrKeptLine, solrMaySet, solrSourceLine } from '@/model/solr-credentials';
import type { SolrCredentialsView } from '@/model/wire';
import { useHopper } from '@/store';

function Form({ view, onSaved }: { view: SolrCredentialsView; onSaved: (v: SolrCredentialsView) => void }) {
  const [busy, setBusy] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const act = async (body: { action: 'set'; username: string; password: string } | { action: 'remove' }) => {
    setBusy(true);
    try {
      onSaved(await post<SolrCredentialsView>('/ui/api/solr-credentials', body));
      setUsername(''); setPassword('');
      toast.success(body.action === 'set' ? 'Solr credentials saved' : 'Solr credentials removed');
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only the hopper\'s admin changes the Solr credentials' : (e as Error).message);
    }
    setBusy(false);
  };
  const may = solrMaySet(view);
  return (
    <div data-slot="solr-credentials" className="space-y-3 text-sm">
      <p className="text-xs text-muted-foreground">
        A managed Solr asks for a username and a password. Give them at launch, or keep them here, in the hopper&apos;s vault. The hopper
        checks them once against Solr before it keeps them, and sends them on every call to Solr.
      </p>
      {view.url && <p className="text-xs"><span className="text-muted-foreground">Solr: </span><code className="font-mono break-all">{view.url}</code></p>}
      <p data-slot="solr-credentials-source">{solrSourceLine(view)}</p>
      <p data-slot="solr-credentials-kept" className="text-xs text-muted-foreground">{solrKeptLine(view.kept)}</p>
      {view.problem && <p role="alert" className="text-xs text-destructive">{view.problem}</p>}
      {may && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void act({ action: 'set', username, password }); }}>
          <Input className="h-8 w-48" aria-label="Solr username" autoComplete="off" placeholder="Username" disabled={busy} value={username} onChange={(e) => setUsername(e.target.value)} />
          <Input className="h-8 w-56" aria-label="Solr password" type="password" autoComplete="new-password" placeholder={view.kept.set ? 'Type a new one to replace it' : 'Password'} disabled={busy} value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button size="sm" type="submit" disabled={busy || !username.trim() || !password}>Check and save</Button>
        </form>
      )}
      {view.kept.set && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: 'remove' })}><Trash2 />Remove from the vault</Button>}
    </div>
  );
}

/** Read when shown. */
export function SolrCredentials() {
  const [view, setView] = useState<SolrCredentialsView | null>(null);
  useEffect(() => { get<SolrCredentialsView>('/api/solr-credentials').then((v) => { if (typeof v?.configured === 'boolean' && v.kept) setView(v); }, () => {}); }, []);
  return (
    <Panel title="Search" icon={Search} className="max-w-3xl">
      {view ? <Form view={view} onSaved={setView} /> : <p className="text-sm text-muted-foreground">Loading…</p>}
    </Panel>
  );
}
