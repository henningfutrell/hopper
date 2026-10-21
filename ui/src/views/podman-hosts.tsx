// Podman hosts (issue #2272): computers with rootless Podman that the user's sandboxes may start on, reached over ssh —
// `podman system dial-stdio`, with the hopper's own key and the host key a person confirmed from its fingerprint. Each
// host is a name, an ssh destination, the pinned key, and the most CPUs and memory a box gets there. The whole list is
// saved against the version read (POST /ui/api/podman-hosts); the next sandbox reads it. A host is used once the sandbox
// host names it: a host here is added to it, last, with one click (POST /ui/api/machines/sandbox-host). A section of Settings.
import { Box, Container } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { get, post, SessionRejected } from '@/lib/api';
import type { HostKeyOffer, PodmanHost, PodmanHostsView } from '@/model/wire';
import { act, useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

interface Draft { name: string; ssh: string; label: string; cpus: string; memoryMb: string }
const EMPTY: Draft = { name: '', ssh: '', label: '', cpus: '', memoryMb: '' };
/** The authorized_keys options the host gives the hopper's key: it runs dial-stdio only. */
const KEY_OPTIONS = 'command="podman system dial-stdio",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding';

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
  view: PodmanHostsView; editing: PodmanHost | undefined; onSaved: () => void; onCancel: () => void; save: (hosts: PodmanHost[], done: string) => Promise<boolean>;
}) {
  const [d, setD] = useState<Draft>(() => (editing ? { name: editing.name, ssh: editing.ssh, label: editing.label ?? '', cpus: editing.cpus?.toString() ?? '', memoryMb: editing.memoryMb?.toString() ?? '' } : EMPTY));
  const [offer, setOffer] = useState<HostKeyOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (over: Partial<Draft>) => { setD((x) => ({ ...x, ...over })); if (over.ssh !== undefined) setOffer(null); };
  const keep = editing && editing.ssh === d.ssh ? editing.hostKey : undefined;
  const taken = !editing && view.hosts.some((h) => h.name === d.name.trim());
  const ready = d.name.trim() !== '' && d.ssh.trim() !== '' && !taken;
  const write = async (hostKey: string) => {
    const [cpus, memoryMb] = [d.cpus.trim(), d.memoryMb.trim()];
    const host: PodmanHost = { name: d.name.trim(), ssh: d.ssh.trim(), hostKey, ...(d.label.trim() ? { label: d.label.trim() } : {}), ...(cpus ? { cpus: Number(cpus) } : {}), ...(memoryMb ? { memoryMb: Number(memoryMb) } : {}) };
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
    <form data-slot="podman-host-form" className="grid gap-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="name" hint={taken ? 'a Podman host has this name' : 'how the sandbox host names it: lower case letters, digits and -'}>
          <Input className="h-9" value={d.name} disabled={busy || editing !== undefined} autoCapitalize="none" spellCheck={false} placeholder="sandbox-vm" onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="ssh destination" hint="user@host: rootless Podman 4 or later in that account">
          <Input className="h-9 font-mono" value={d.ssh} disabled={busy} autoCapitalize="none" spellCheck={false} placeholder="sandbox@sandbox-vm.lan" onChange={(e) => set({ ssh: e.target.value.trim() })} />
        </Field>
        <Field label="label" hint="optional; what the host is for">
          <Input className="h-9" value={d.label} disabled={busy} placeholder="the sandbox VM" onChange={(e) => set({ label: e.target.value })} />
        </Field>
        <Field label="most CPUs a box gets" hint="optional; empty: what each box asks for">
          <Input className="h-9" inputMode="decimal" value={d.cpus} disabled={busy} placeholder="4" onChange={(e) => set({ cpus: e.target.value })} />
        </Field>
        <Field label="most memory a box gets (MiB)" hint="optional; empty: what each box asks for">
          <Input className="h-9" inputMode="numeric" value={d.memoryMb} disabled={busy} placeholder="8192" onChange={(e) => set({ memoryMb: e.target.value })} />
        </Field>
      </div>
      {confirming && (
        <div data-slot="podman-host-key" className="space-y-1 rounded-md border bg-muted/40 p-2 text-xs">
          <div>{offer.known ? 'The host key in ~/.ssh/known_hosts' : 'The host key the host presents now'}: <span className="font-mono">{offer.fingerprint}</span></div>
          <div className="text-muted-foreground">Compare it with the host's own (on the host: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub). The hopper trusts only this key.</div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" type="submit" disabled={busy || !ready}>{keep ? 'Save' : confirming ? 'Pin this key and save' : 'Read its host key'}</Button>
        <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

/** The host's place in the sandbox host, or a button that adds it there, last. */
function SandboxHostPlace({ name, authed }: { name: string; authed: boolean }) {
  const hosts = useHopper((s) => s.sandboxHost) ?? [];
  const at = hosts.indexOf(name);
  if (at >= 0) return <span data-slot="podman-host-place" className="text-xs text-muted-foreground">{at === 0 ? 'the sandbox host' : `sandbox host, place ${at + 1}`}</span>;
  if (!authed) return null;
  return <Button size="sm" variant="outline" onClick={() => void act('/ui/api/machines/sandbox-host', { hosts: [...hosts, name] }, `${name} is a sandbox host now`)}><Box />Use as sandbox host</Button>;
}

export function PodmanHosts() {
  const authed = useCanAdmin();
  const [view, setView] = useState<PodmanHostsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<{ editing?: PodmanHost } | null>(null);
  // The hopper's own public key (absent while the runtime mounts a key): the authorized_keys line is shown whole.
  const [publicKey, setPublicKey] = useState<string | undefined>();
  useEffect(() => {
    get<PodmanHostsView>('/api/podman-hosts').then(setView, (e: Error) => setError(e.message));
    get<{ ssh?: { publicKey?: string } }>('/api/machines/config').then((c) => setPublicKey(c.ssh?.publicKey), () => undefined);
  }, []);
  const save = async (hosts: PodmanHost[], done: string): Promise<boolean> => {
    if (!view) return false;
    try {
      setView(await post<PodmanHostsView>('/ui/api/podman-hosts', { hosts, version: view.version }));
      toast.success(`${done}; the next sandbox reads it`);
      return true;
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
      return false;
    }
  };
  return (
    <div data-slot="podman-hosts">
      <Panel title="Podman hosts" icon={Container} count={view?.hosts.length} bodyClassName="space-y-4">
        <p className="text-sm text-muted-foreground">
          A computer with rootless Podman, set up only for sandboxes. When the sandbox host names it, sandboxes start there and nowhere else.
          The hopper reaches it over ssh with its own key, and runs each call through <span className="font-mono">podman system dial-stdio</span>.
          Vault secrets go into a box there by a copy. No job and no hopper client run there.
        </p>
        <p className="text-xs text-muted-foreground">
          On the host, put the hopper's public key in the account's <span className="font-mono">~/.ssh/authorized_keys</span> with these options first, so the key can run nothing else:{' '}
          <span data-slot="podman-host-key-line" className="break-all font-mono">{KEY_OPTIONS} {publicKey ?? '<the hopper\'s public key>'}</span>
        </p>
        {view ? (
          <>
            {view.hosts.length === 0 && <Empty>No Podman host yet.</Empty>}
            <ul className="space-y-2">
              {view.hosts.map((h) => (
                <li key={h.name} data-slot="podman-host" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
                  <span className="font-medium">{h.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{h.ssh}</span>
                  {h.label && <span className="text-xs text-muted-foreground">{h.label}</span>}
                  {(h.cpus !== undefined || h.memoryMb !== undefined) && (
                    <span className="text-xs text-muted-foreground">a box gets at most {[h.cpus !== undefined && `${h.cpus} CPUs`, h.memoryMb !== undefined && `${h.memoryMb} MiB`].filter(Boolean).join(', ')}</span>
                  )}
                  <SandboxHostPlace name={h.name} authed={authed} />
                  {authed && (
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setForm({ editing: h })}>Edit</Button>
                      <Confirm title={`Remove ${h.name}?`} description="Sandboxes no longer start on it. One running there now goes on. While the sandbox host names it, steps wait for it." action="Remove"
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
              : <Button size="sm" variant="outline" onClick={() => setForm({})}>Add a Podman host</Button>)}
          </>
        ) : <Empty>{error ?? 'loading…'}</Empty>}
      </Panel>
    </div>
  );
}
