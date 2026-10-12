// Windows hosts (issue #731): where a job's Windows sandbox steps run — `sh "$HOPPER_STEP" run NAME` on a Linux
// machine, one step at a time per host, over ssh, in PowerShell, in the host's working directory. Each host is a name,
// an ssh destination, the host key a person confirmed from its fingerprint, and the working directory. The whole list
// is saved against the version read (POST /ui/api/windows-hosts); the next step reads it. A section of Settings.
import { MonitorCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { get, post, SessionRejected } from '@/lib/api';
import type { HostKeyOffer, WindowsHost, WindowsHostsView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

interface Draft { name: string; ssh: string; workDir: string; label: string }
const EMPTY: Draft = { name: '', ssh: '', workDir: '', label: '' };

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <label className="grid gap-1 text-xs">
      <span className="font-medium text-foreground/90">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** The add or edit form. Editing keeps the pinned key while the ssh destination stays the same. */
function HostForm({ view, editing, onSaved, onCancel, save }: {
  view: WindowsHostsView; editing: WindowsHost | undefined; onSaved: () => void; onCancel: () => void; save: (hosts: WindowsHost[], done: string) => Promise<boolean>;
}) {
  const [d, setD] = useState<Draft>(() => (editing ? { name: editing.name, ssh: editing.ssh, workDir: editing.workDir, label: editing.label ?? '' } : EMPTY));
  const [offer, setOffer] = useState<HostKeyOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (over: Partial<Draft>) => { setD((x) => ({ ...x, ...over })); if (over.ssh !== undefined) setOffer(null); };
  const keep = editing && editing.ssh === d.ssh ? editing.hostKey : undefined;
  const taken = !editing && view.hosts.some((h) => h.name === d.name.trim());
  const ready = d.name.trim() !== '' && d.ssh.trim() !== '' && d.workDir.trim() !== '' && !taken;
  const write = async (hostKey: string) => {
    const host: WindowsHost = { name: d.name.trim(), ssh: d.ssh.trim(), hostKey, workDir: d.workDir.trim(), ...(d.label.trim() ? { label: d.label.trim() } : {}) };
    const hosts = editing ? view.hosts.map((h) => (h.name === editing.name ? host : h)) : [...view.hosts, host];
    if (await save(hosts, editing ? `Saved ${host.name}` : `Added ${host.name}`)) onSaved();
  };
  const submit = async () => {
    if (keep) return write(keep);
    if (offer?.ssh === d.ssh.trim()) return write(offer.hostKey);
    setBusy(true);
    try {
      setOffer(await post<HostKeyOffer>('/ui/api/machines/host-key', { ssh: d.ssh.trim() }));
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const confirming = !keep && offer !== null && offer.ssh === d.ssh.trim();
  return (
    <form data-slot="windows-host-form" className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="name" hint={taken ? 'a Windows host has this name' : 'how a job names it: lower case letters, digits and -'}>
          <Input className="h-9" value={d.name} disabled={busy || editing !== undefined} autoCapitalize="none" spellCheck={false} placeholder="build-host" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="ssh destination" hint="user@host: OpenSSH on the host, with the hopper's public key in that account's authorized keys">
          <Input className="h-9 font-mono" value={d.ssh} disabled={busy} autoCapitalize="none" spellCheck={false} placeholder="builder@winbox.lan" onChange={(e) => set({ ssh: e.target.value.trim() })} />
        </Field>
        <Field label="working directory" hint="where every step runs: inputs land here, outputs come from here">
          <Input className="h-9 font-mono" value={d.workDir} disabled={busy} spellCheck={false} placeholder="C:\work\app" onChange={(e) => set({ workDir: e.target.value })} />
        </Field>
        <Field label="label" hint="optional; what the host is for">
          <Input className="h-9" value={d.label} disabled={busy} placeholder=".NET Framework builds" onChange={(e) => set({ label: e.target.value })} />
        </Field>
      </div>
      {confirming && (
        <div data-slot="windows-host-key" className="space-y-1 rounded-md border bg-muted/40 p-2 text-xs">
          <div>{offer.known ? 'The host key in ~/.ssh/known_hosts' : 'The host key the host presents now'}: <span className="font-mono">{offer.fingerprint}</span></div>
          <div className="text-muted-foreground">Compare it with the host's own (on the host: ssh-keygen -lf C:\ProgramData\ssh\ssh_host_ed25519_key.pub). The hopper trusts only this key.</div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy || !ready}>{keep ? 'Save' : confirming ? 'Pin this key and save' : 'Read its host key'}</Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

export function WindowsHosts() {
  const authed = useCanAdmin();
  const [view, setView] = useState<WindowsHostsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing?: WindowsHost } | null>(null);
  useEffect(() => { get<WindowsHostsView>('/api/windows-hosts').then(setView, (e: Error) => setError(e.message)); }, []);
  const save = async (hosts: WindowsHost[], done: string): Promise<boolean> => {
    if (!view) return false;
    try {
      setView(await post<WindowsHostsView>('/ui/api/windows-hosts', { hosts, version: view.version }));
      toast.success(`${done}; the next step reads it`);
      return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  return (
    <div data-slot="windows-hosts">
      <Panel title="Windows hosts" icon={MonitorCog} count={view?.hosts.length} bodyClassName="space-y-4">
        <p className="text-sm text-muted-foreground">
          A job on a Linux machine runs one step of its work here when it needs Windows: a .NET Framework build, a Windows app's tests.
          The hopper runs the step over ssh in PowerShell, in the host's working directory, one step at a time, and streams its output back.
          No agent and no hopper client run on Windows.
        </p>
        {view ? (
          <>
            {view.hosts.length === 0 && <Empty>No Windows host yet.</Empty>}
            <ul className="space-y-2">
              {view.hosts.map((h) => (
                <li key={h.name} data-slot="windows-host" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{h.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{h.ssh}</span>
                  <span className="font-mono text-xs text-muted-foreground">{h.workDir}</span>
                  {h.label && <span className="text-xs text-muted-foreground">{h.label}</span>}
                  {authed && (
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setForm({ editing: h })}>Edit</Button>
                      <Confirm title={`Remove ${h.name}?`} description="Jobs can no longer run steps on it. A step running there now goes on." action="Remove"
                        onConfirm={() => void save(view.hosts.filter((x) => x.name !== h.name), `Removed ${h.name}`)}>
                        <Button size="sm" variant="ghost">Remove</Button>
                      </Confirm>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            {authed && (form
              ? <HostForm key={form.editing?.name ?? 'new'} view={view} editing={form.editing} save={save} onSaved={() => setForm(null)} onCancel={() => setForm(null)} />
              : <Button size="sm" variant="outline" onClick={() => setForm({})}>Add a Windows host</Button>)}
          </>
        ) : <Empty>{error ?? 'loading…'}</Empty>}
      </Panel>
    </div>
  );
}
