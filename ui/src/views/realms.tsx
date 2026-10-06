// Sign-in (issues #185, #200): the realms, in the order the username and password form tries them and
// the sign-in buttons show them, each on or off, moved, edited in a form of its type's fields or
// removed; a realm added from the form of the chosen type; a password realm's accounts under it
// (realm-accounts.tsx); the login code and no sign-in. No YAML: every setting is a field. In Settings,
// admin only (GET /api/realms). Every change is POST /ui/api/realms against the version read, and
// applies at once; the daemon refuses one that would not load, or that would end your own admin
// session, and the refusal is shown where the change was made.
import { ArrowDown, ArrowUp, Copy, KeyRound, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { get, post, SessionRejected } from '@/lib/api';
import { draftOf, emptyDraft, realmOf, REALM_FIELDS, REALM_TYPE_LABELS, RULE_MATCHES, type RealmDraft, type RealmField, type RuleMatch } from '@/model/realms';
import type { RealmType, RealmView, RealmsEdit, RealmsView, UiRole, UserView } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';
import { RealmAccounts, SELECT, type AccountChange } from './realm-accounts';

/** The editor: a realm being added (`editing` undefined) or changed (its name). */
type Editing = { editing?: string; draft: RealmDraft };

export function Realms() {
  const canAdmin = useCanAdmin();
  const [view, setView] = useState<RealmsView | null>(null);
  const [users, setUsers] = useState<UserView[]>([]);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // GET /api/realms and /api/users answer an admin session (or loopback without one): nobody else reads them.
  useEffect(() => {
    if (!canAdmin) return;
    void get<RealmsView>('/api/realms').then(setView, (e: unknown) => toast.error((e as Error).message));
    void get<{ users: UserView[] }>('/api/users').then((r) => setUsers(r.users), () => {});
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
    const ok = await change({ action: 'save', realm: realmOf(editing.draft), version, ...(editing.editing === undefined ? {} : { name: editing.editing }) }, 'Saved: sign-in follows it now');
    if (ok) setEditing(null);
  };
  const accountChange = (c: AccountChange, done?: string) => change({ ...c, version } as RealmsEdit, done);

  return (
    <div className="space-y-3">
      <Panel title="Realms" icon={KeyRound} count={view.realms.length}
        action={!editing ? <Button size="xs" variant="outline" className="gap-1" onClick={() => { setError(null); setEditing({ draft: emptyDraft('oidc') }); }}><Plus />Add realm</Button> : undefined}>
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
                  onEdit={() => { setError(null); setEditing({ editing: r.name, draft: draftOf(r) }); }}
                  onRemove={() => void change({ action: 'remove', name: r.name, version }, `${r.label} removed`)}
                  position={i}>
                  {r.type === 'password' && <RealmAccounts realm={r.name} accounts={r.accounts ?? []} users={users} busy={busy} change={accountChange} />}
                </RealmRow>
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

function RealmRow({ realm: r, first, last, busy, position, onEnable, onMove, onEdit, onRemove, children }: {
  realm: RealmView; first: boolean; last: boolean; busy: boolean; position: number;
  onEnable: (enabled: boolean) => void; onMove: (to: number) => void; onEdit: () => void; onRemove: () => void; children?: React.ReactNode;
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
            description={`People who signed in with it are signed out at once, and nobody can sign in with it any more.${r.type === 'password' ? ' Its accounts go with it.' : ''}`}>
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
      {children}
    </li>
  );
}

const LABEL = 'grid gap-1 text-xs';

function FieldInput({ f, value, disabled, set }: { f: RealmField; value: string | boolean | undefined; disabled: boolean; set: (v: string | boolean) => void }) {
  const help = f.help && <span className="text-muted-foreground">{f.help}</span>;
  if (f.kind === 'switch') {
    return (
      <label className="flex items-center gap-2 text-xs sm:col-span-2">
        <Switch checked={value === true} disabled={disabled} aria-label={f.label} onCheckedChange={set} />
        <span><span className="font-medium">{f.label}</span>{help && <> — {help}</>}</span>
      </label>
    );
  }
  const text = typeof value === 'string' ? value : '';
  return (
    <label className={`${LABEL} ${f.kind === 'multiline' ? 'sm:col-span-2' : ''}`}>
      <span className="font-medium">{f.label}</span>
      {f.kind === 'multiline'
        ? <Textarea aria-label={f.label} rows={5} spellCheck={false} className="font-mono text-xs" placeholder={f.placeholder} value={text} disabled={disabled} onChange={(e) => set(e.target.value)} />
        : <Input aria-label={f.label} spellCheck={false} className="font-mono text-xs" placeholder={f.placeholder} value={text} disabled={disabled} onChange={(e) => set(e.target.value)} />}
      {help}
    </label>
  );
}

function RoleRules({ draft, set, disabled }: { draft: RealmDraft; set: (d: RealmDraft) => void; disabled: boolean }) {
  const rule = (i: number, patch: Partial<RealmDraft['rules'][number]>) => set({ ...draft, rules: draft.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="text-xs"><span className="font-medium">Role rules</span> <span className="text-muted-foreground">— the highest role a rule grants wins; someone no rule matches gets the default role.</span></div>
      {draft.rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-start gap-2 rounded-md border p-2">
          <select aria-label={`Rule ${i + 1} role`} className={SELECT} value={r.role} disabled={disabled} onChange={(e) => rule(i, { role: e.target.value as UiRole })}>
            <option value="admin">admin</option><option value="operator">operator</option><option value="viewer">viewer</option>
          </select>
          <span className="py-1.5 text-xs text-muted-foreground">for these</span>
          <select aria-label={`Rule ${i + 1} matches`} className={SELECT} value={r.match} disabled={disabled} onChange={(e) => rule(i, { match: e.target.value as RuleMatch })}>
            {RULE_MATCHES.map((m) => <option key={m.match} value={m.match}>{m.label}</option>)}
          </select>
          <Textarea aria-label={`Rule ${i + 1} values`} rows={2} spellCheck={false} className="min-w-48 flex-1 font-mono text-xs" placeholder="one per line"
            value={r.values} disabled={disabled} onChange={(e) => rule(i, { values: e.target.value })} />
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove rule ${i + 1}`} disabled={disabled}
            onClick={() => set({ ...draft, rules: draft.rules.filter((_, j) => j !== i) })}><X /></Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant="outline" className="gap-1" disabled={disabled}
          onClick={() => set({ ...draft, rules: [...draft.rules, { role: 'viewer', match: 'emails', values: '' }] })}><Plus />Add rule</Button>
        <label className="flex items-center gap-2 text-xs">
          <span className="font-medium">Default role</span>
          <select aria-label="Default role" className={SELECT} value={draft.defaultRole} disabled={disabled} onChange={(e) => set({ ...draft, defaultRole: e.target.value as UiRole | '' })}>
            <option value="">none: no session</option><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option>
          </select>
        </label>
      </div>
    </div>
  );
}

function Editor({ editing, setEditing, error, busy, onSave, onCancel }: {
  editing: Editing; setEditing: (e: Editing) => void; error: string | null; busy: boolean; onSave: () => void; onCancel: () => void;
}) {
  const { draft } = editing;
  const adding = editing.editing === undefined;
  const set = (d: RealmDraft) => setEditing({ ...editing, draft: d });
  return (
    <form className="space-y-3 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); onSave(); }}>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{adding ? 'New realm' : `Edit ${editing.editing}`}</span>
        {adding && (
          <select aria-label="Realm type" className={SELECT} value={draft.type} disabled={busy}
            onChange={(e) => set({ ...emptyDraft(e.target.value as RealmType), name: draft.name, label: draft.label })}>
            {REALM_TYPE_LABELS.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
          </select>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {adding && (
          <label className={LABEL}>
            <span className="font-medium">Name</span>
            <Input aria-label="Name" spellCheck={false} className="font-mono text-xs" placeholder="sso" value={draft.name} disabled={busy} onChange={(e) => set({ ...draft, name: e.target.value })} />
            <span className="text-muted-foreground">lowercase letters, digits and dashes; part of the callback URL, and fixed once saved</span>
          </label>
        )}
        <label className={LABEL}>
          <span className="font-medium">Label</span>
          <Input aria-label="Label" placeholder={draft.name || 'Company SSO'} value={draft.label} disabled={busy} onChange={(e) => set({ ...draft, label: e.target.value })} />
          <span className="text-muted-foreground">shown on the sign-in button; empty: the name</span>
        </label>
        {REALM_FIELDS[draft.type].map((f) => (
          <FieldInput key={f.path} f={f} value={draft.values[f.path]} disabled={busy} set={(v) => set({ ...draft, values: { ...draft.values, [f.path]: v } })} />
        ))}
        {draft.type === 'password'
          ? <p className="text-xs text-muted-foreground sm:col-span-2">Its accounts are added under the realm once it is saved: each with a username, a password and a role.</p>
          : <RoleRules draft={draft} set={set} disabled={busy} />}
      </div>
      <p className="text-xs text-muted-foreground">Secrets are never entered here: name the daemon's environment variable that holds one, and set it where the daemon runs. Every setting: docs/sign-in.md in the hopper's install.</p>
      {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !draft.name.trim()}>Save</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
