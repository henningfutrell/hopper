// Clusters (issue #1766): the cluster overrides — how the vault finds a cluster with no minting credential of its own in
// the AWS accounts it mints for. With none, a cluster is found by its own name, in every account, as the read role
// hopper-read, for a read only. An override names the cluster's name in EKS (an alias), the one account and the region to
// look in, and the IAM role a write signs in as. No secret: a cluster holds none. The whole list is saved against the
// version read (POST /ui/api/clusters); the next mint reads it. A section of Settings.
import { Boxes } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { get, post, SessionRejected } from '@/lib/api';
import type { ClusterOverride, ClustersView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

type Draft = Record<keyof ClusterOverride, string>;
const EMPTY: Draft = { name: '', eksName: '', account: '', region: '', writeRole: '' };
const OPTIONAL = ['eksName', 'account', 'region', 'writeRole'] as const;

function Field({ label, hint, children }: { label: string; hint: string; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="font-medium text-foreground/90">{label}</span>
      {children}
      <span className="text-muted-foreground">{hint}</span>
    </label>
  );
}

function OverrideForm({ view, editing, onSaved, onCancel, save }: {
  view: ClustersView; editing: ClusterOverride | undefined; onSaved: () => void; onCancel: () => void; save: (clusters: ClusterOverride[], done: string) => Promise<boolean>;
}) {
  const [d, setD] = useState<Draft>(() => ({ ...EMPTY, ...editing }));
  const [busy, setBusy] = useState(false);
  const set = (over: Partial<Draft>) => setD((x) => ({ ...x, ...over }));
  const name = d.name.trim();
  const taken = !editing && view.clusters.some((c) => c.name === name);
  const submit = async () => {
    const c: ClusterOverride = { name, ...Object.fromEntries(OPTIONAL.map((k) => [k, d[k].trim()]).filter(([, v]) => v !== '')) };
    const clusters = editing ? view.clusters.map((x) => (x.name === editing.name ? c : x)) : [...view.clusters, c];
    setBusy(true);
    if (await save(clusters, editing ? `Saved ${name}` : `Added ${name}`)) onSaved();
    setBusy(false);
  };
  const input = (k: keyof Draft, placeholder: string, mono = true) => (
    <Input data-slot={`cluster-${k}`} className={`h-9${mono ? ' font-mono' : ''}`} value={d[k]} disabled={busy || (k === 'name' && editing !== undefined)} autoCapitalize="none" spellCheck={false} placeholder={placeholder} onChange={(e) => set({ [k]: e.target.value })} />
  );
  return (
    <form data-slot="cluster-form" className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="cluster" hint={taken ? 'this cluster has an override' : 'the name templates and Access use: cluster/<name>'}>{input('name', 'utility-identity-edit')}</Field>
        <Field label="name in EKS" hint="optional; when EKS names the cluster differently">{input('eksName', 'utility')}</Field>
        <Field label="AWS account" hint="optional; the one account to look in (12 digits). It needs an aws-account minting credential.">{input('account', '111111111111')}</Field>
        <Field label="region" hint="optional; in place of the minting credential's region">{input('region', 'eu-west-1')}</Field>
        <Field label="write role" hint="optional; the IAM role a write signs in as, in the cluster's account. The cluster's access entry decides what it may do. Without it, only a read is found.">{input('writeRole', 'hopper-identity-edit')}</Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy || name === '' || taken}>Save</Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function Clusters() {
  const authed = useCanAdmin();
  const [view, setView] = useState<ClustersView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing?: ClusterOverride } | null>(null);
  useEffect(() => { get<ClustersView>('/api/clusters').then(setView, (e: Error) => setError(e.message)); }, []);
  const save = async (clusters: ClusterOverride[], done: string): Promise<boolean> => {
    if (!view) return false;
    try {
      setView(await post<ClustersView>('/ui/api/clusters', { clusters, version: view.version }));
      toast.success(`${done}; the next mint reads it`);
      return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  return (
    <div data-slot="clusters">
      <Panel title="Clusters" icon={Boxes} count={view?.clusters.length} bodyClassName="space-y-4">
        <p className="text-sm text-muted-foreground">
          The vault finds an EKS cluster in the AWS accounts it has a minting credential for, and signs in as the read role hopper-read.
          A cluster needs no vault secret. An override changes how the vault finds one cluster: its name in EKS, the account and the region, and the role a write signs in as.
          A cluster's own minting credential still wins.
        </p>
        {view ? (
          <>
            {view.clusters.length === 0 && <Empty>No override: every cluster is found by its own name, for a read only.</Empty>}
            <ul className="space-y-2">
              {view.clusters.map((c) => (
                <li key={c.name} data-slot="cluster" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{c.name}</span>
                  {c.eksName && <span className="font-mono text-xs text-muted-foreground">EKS: {c.eksName}</span>}
                  {c.account && <span className="font-mono text-xs text-muted-foreground">account: {c.account}</span>}
                  {c.region && <span className="font-mono text-xs text-muted-foreground">{c.region}</span>}
                  {c.writeRole && <span className="font-mono text-xs text-muted-foreground">write: {c.writeRole}</span>}
                  {authed && (
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setForm({ editing: c })}>Edit</Button>
                      <Confirm title={`Remove ${c.name}?`} description="The vault finds the cluster by its own name again, for a read only. A token minted already stays valid until it expires." action="Remove"
                        onConfirm={() => void save(view.clusters.filter((x) => x.name !== c.name), `Removed ${c.name}`)}>
                        <Button size="sm" variant="ghost">Remove</Button>
                      </Confirm>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {authed && (form
              ? <OverrideForm key={form.editing?.name ?? 'new'} view={view} editing={form.editing} save={save} onSaved={() => setForm(null)} onCancel={() => setForm(null)} />
              : <Button size="sm" variant="outline" onClick={() => setForm({})}>Add a cluster override</Button>)}
          </>
        ) : <Empty>{error ?? 'loading…'}</Empty>}
      </Panel>
    </div>
  );
}
