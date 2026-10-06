// Sign-in (issue #185, design.md "Sign-in: realms"): the realms, in the order the username and password
// form tries them and the sign-in buttons show them, each on or off, moved, edited as its auth.yaml
// entry or removed; a realm added from a starting entry of its type; the login code and no sign-in. In
// Settings, admin only (GET /api/realms). Every change is POST /ui/api/realms against the version read,
// and applies at once; the daemon refuses one that would not load, or that would end your own admin
// session, and the refusal is shown where the change was made.
import { ArrowDown, ArrowUp, Copy, KeyRound, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { get, post, SessionRejected } from '@/lib/api';
import type { RealmType, RealmView, RealmsEdit, RealmsView, UiRole } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const SELECT = 'h-9 rounded-lg border border-input bg-transparent px-2.5 text-base md:text-sm dark:bg-input/30';
const TYPES: { type: RealmType; label: string }[] = [
  { type: 'password', label: 'Password (accounts in auth.yaml)' },
  { type: 'ldap', label: 'LDAP or Active Directory' },
  { type: 'oidc', label: 'OpenID Connect' },
  { type: 'github', label: 'GitHub' },
  { type: 'saml', label: 'SAML' },
];

/** A starting entry per realm type: the settings each needs, with example values to replace. docs/sign-in.md has them all. */
const STARTER: Record<RealmType, string> = {
  password: 'name: staff\nlabel: Password\ntype: password\nusers: []\n',
  ldap: [
    'name: directory', 'label: Directory', 'type: ldap', 'url: ldaps://ldap.example.com',
    'bindDn: cn=hopper,ou=services,dc=example,dc=com', 'bindPasswordEnv: LDAP_BIND_PASSWORD',
    'userBase: ou=people,dc=example,dc=com', 'userFilter: (uid={username})',
    'roles:', '  admin: { groups: ["cn=hopper-admins,ou=groups,dc=example,dc=com"] }  # quote a DN: a comma splits a [ ] list', '  defaultRole: viewer', '',
  ].join('\n'),
  oidc: [
    'name: sso', 'label: Company SSO', 'type: oidc', 'issuer: https://idp.example.com', 'clientId: hopper', 'clientSecretEnv: SSO_CLIENT_SECRET',
    'roles:', '  admin: { emails: [someone@example.com] }', '  defaultRole: null', '',
  ].join('\n'),
  github: [
    'name: github', 'label: GitHub', 'type: github', 'clientId: <client id>', 'clientSecretEnv: GITHUB_OAUTH_CLIENT_SECRET',
    'roles:', '  admin: { subjects: ["<numeric user id>"] }', '',
  ].join('\n'),
  saml: [
    'name: corp', 'label: Corp SSO', 'type: saml', 'entryPoint: https://idp.example.com/sso/saml',
    'idpCert: |', '  -----BEGIN CERTIFICATE-----', '  <base64 certificate>', '  -----END CERTIFICATE-----', 'idpIssuer: https://idp.example.com/metadata',
    'roles:', '  admin: { groups: [hopper-admins] }', '',
  ].join('\n'),
};

/** The editor: a realm being added (no name) or changed (its name). */
type Editing = { name?: string; type: RealmType; entry: string };

export function Realms() {
  const canAdmin = useCanAdmin();
  const [view, setView] = useState<RealmsView | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // GET /api/realms answers an admin session (or loopback without one): nobody else reads the realms.
  useEffect(() => {
    if (canAdmin) void get<RealmsView>('/api/realms').then(setView, (e: unknown) => toast.error((e as Error).message));
  }, [canAdmin]);

  /** One change; true when it was made. The refusal goes to the editor while it is open, else a toast. */
  const change = async (edit: RealmsEdit, done?: string): Promise<boolean> => {
    setBusy(true);
    try {
      setView(await post<RealmsView>('/ui/api/realms', edit));
      setError(null);
      if (done) toast.success(done);
      return true;
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      if (editing) setError((err as Error).message);
      else toast.error((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (!canAdmin) return <Panel title="Sign-in" icon={KeyRound}><Empty>Only an admin manages sign-in.</Empty></Panel>;
  if (!view) return <Panel title="Sign-in" icon={KeyRound}><Empty>Loading…</Empty></Panel>;
  const { version } = view;

  const save = async () => {
    if (!editing) return;
    const ok = await change({ action: 'save', entry: editing.entry, version, ...(editing.name === undefined ? {} : { name: editing.name }) }, 'Saved: sign-in follows it now');
    if (ok) setEditing(null);
  };

  return (
    <div className="space-y-3">
      <Panel title="Realms" icon={KeyRound} count={view.realms.length}
        action={!editing ? <Button size="xs" variant="outline" className="gap-1" onClick={() => { setError(null); setEditing({ type: 'oidc', entry: STARTER.oidc }); }}><Plus />Add realm</Button> : undefined}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            A realm is one way people sign in. The username and password form tries the password and LDAP realms in this order; the first that accepts the password signs in. The others are sign-in buttons, in this order. A change applies at once.
          </p>
          {editing && <Editor editing={editing} setEditing={setEditing} error={error} busy={busy} onSave={() => void save()} onCancel={() => { setEditing(null); setError(null); }} />}
          {view.realms.length === 0 ? <Empty>No realms: people sign in with the login code{view.none ? ' or without signing in' : ''}.</Empty> : (
            <ul className="divide-y rounded-lg border">
              {view.realms.map((r, i) => (
                <RealmRow key={r.name} realm={r} first={i === 0} last={i === view.realms.length - 1} busy={busy || editing !== null}
                  onEnable={(enabled) => void change({ action: 'enable', name: r.name, enabled, version })}
                  onMove={(to) => void change({ action: 'move', name: r.name, to, version })}
                  onEdit={() => { setError(null); setEditing({ name: r.name, type: r.type, entry: r.entry }); }}
                  onRemove={() => void change({ action: 'remove', name: r.name, version }, `${r.label} removed`)}
                  position={i} />
              ))}
            </ul>
          )}
        </div>
      </Panel>
      <Panel title="Without a realm" icon={KeyRound}>
        <div className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <Switch checked={view.local} disabled={busy} aria-label="Login code" onCheckedChange={(local) => void change({ action: 'settings', local, version })} />
            <span><span className="font-medium">Login code</span> <span className="text-muted-foreground">— a one-time code from <code className="font-mono text-xs">hopper login-code</code> or a device link; signs in as admin.</span></span>
          </label>
          <label className="flex flex-wrap items-center gap-2">
            <span className="font-medium">No sign-in</span>
            <select aria-label="No sign-in" className={SELECT} value={view.none ?? ''} disabled={busy}
              onChange={(e) => void change({ action: 'settings', none: e.target.value === '' ? null : e.target.value as UiRole, version })}>
              <option value="">off</option>
              <option value="viewer">anyone may look (viewer)</option>
              <option value="operator">anyone may act on jobs (operator)</option>
              <option value="admin">anyone may change everything (admin)</option>
            </select>
            <span className="text-muted-foreground">Only behind something else that decides who gets in.</span>
          </label>
        </div>
      </Panel>
    </div>
  );
}

function RealmRow({ realm: r, first, last, busy, position, onEnable, onMove, onEdit, onRemove }: {
  realm: RealmView; first: boolean; last: boolean; busy: boolean; position: number;
  onEnable: (enabled: boolean) => void; onMove: (to: number) => void; onEdit: () => void; onRemove: () => void;
}) {
  const copy = (l: string) => navigator.clipboard?.writeText(l).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  return (
    <li data-realm={r.name} className="space-y-1 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Switch checked={r.enabled} disabled={busy} aria-label={`${r.label} on`} onCheckedChange={onEnable} />
        <span className="min-w-0 truncate font-medium">{r.label}</span>
        <StatusBadge status={r.type} tone="muted" />
        {r.label !== r.name && <span className="truncate font-mono text-xs text-muted-foreground">{r.name}</span>}
        {!r.enabled && <span className="text-xs text-muted-foreground">off</span>}
        <span className="ml-auto flex items-center gap-0.5">
          <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={busy || first} onClick={() => onMove(position - 1)}><ArrowUp /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Move down" disabled={busy || last} onClick={() => onMove(position + 1)}><ArrowDown /></Button>
          <Button variant="ghost" size="icon-xs" aria-label="Edit" disabled={busy} onClick={onEdit}><Pencil /></Button>
          <Confirm title={`Remove ${r.label}?`} action="Remove" onConfirm={onRemove}
            description="People who signed in with it are signed out at once, and nobody can sign in with it any more.">
            <Button variant="ghost" size="icon-xs" aria-label="Remove" disabled={busy}><Trash2 /></Button>
          </Confirm>
        </span>
      </div>
      {r.callback && (
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">{r.type === 'saml' ? 'Assertion consumer service' : 'Callback URL'}:</span>
          <code className="min-w-0 truncate font-mono" title={r.callback}>{r.callback}</code>
          <Button variant="ghost" size="icon-xs" aria-label="Copy callback URL" onClick={() => copy(r.callback!)}><Copy /></Button>
        </div>
      )}
      {r.metadata && (
        <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="shrink-0">Entity id and metadata:</span>
          <code className="min-w-0 truncate font-mono" title={r.metadata}>{r.metadata}</code>
          <Button variant="ghost" size="icon-xs" aria-label="Copy metadata URL" onClick={() => copy(r.metadata!)}><Copy /></Button>
        </div>
      )}
    </li>
  );
}

function Editor({ editing, setEditing, error, busy, onSave, onCancel }: {
  editing: Editing; setEditing: (e: Editing) => void; error: string | null; busy: boolean; onSave: () => void; onCancel: () => void;
}) {
  const adding = editing.name === undefined;
  return (
    <form className="space-y-2 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{adding ? 'New realm' : `Edit ${editing.name}`}</span>
        {adding && (
          <select aria-label="Realm type" className={SELECT} value={editing.type} disabled={busy}
            onChange={(e) => { const type = e.target.value as RealmType; setEditing({ type, entry: STARTER[type] }); }}>
            {TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        The realm's entry in auth.yaml. Secrets are never written here: name the variable that holds one (<code className="font-mono">clientSecretEnv</code>, <code className="font-mono">bindPasswordEnv</code>) and set it in the daemon's environment. Every setting: docs/sign-in.md in the hopper's install.
      </p>
      <Textarea aria-label="Realm" rows={12} spellCheck={false} className="font-mono text-xs" value={editing.entry} disabled={busy}
        onChange={(e) => setEditing({ ...editing, entry: e.target.value })} />
      {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !editing.entry.trim()}>Save</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
