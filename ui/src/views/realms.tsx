// Sign-in (issues #185, #200, #237, #256, #264), as sign-in works: people sign in with GitHub through the
// hopper's app, signing in also connects the GitHub their jobs work through, and the first of them is
// the admin (issues #214, #239) — the page says so, names them, and says who else gets in. Then the other
// ways to sign in, optional (a directory, an identity provider, an auth gateway): each on or off, moved
// among themselves, edited in a form of its type's fields or removed; one added from the form of the
// chosen type; whoever signs in one of those ways connects their GitHub in Sources for their jobs.
// Then device links (the login code) and no sign-in, each saying what it does. Every switch
// says On or Off in words. The hopper keeps no password accounts of its own. No YAML: every setting is a
// field. In Settings, admin only (GET /api/realms). Every change is POST /ui/api/realms against the
// version read, and applies at once; the daemon refuses one that would not load, or that would end your
// own admin session, and the refusal is shown where the change was made.
// Admins: ./admins.tsx (issue #242).
import { ArrowDown, ArrowUp, Copy, KeyRound, Link, Pencil, Plus, ShieldOff, Trash2, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Admins } from '@/views/admins';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { get, post, SessionRejected } from '@/lib/api';
import { draftOf, emptyDraft, realmOf, REALM_FIELDS, REALM_TYPE_LABELS, REALM_TYPE_SHORT, RULE_MATCHES, whoGetsIn, type RealmDraft, type RealmField, type RuleMatch } from '@/model/realms';
import type { RealmType, RealmView, RealmsEdit, RealmsView, UiRole } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdminInstance } from '@/store/selectors';

const SELECT = 'h-8 rounded-lg border border-input bg-transparent px-2 text-base md:text-sm dark:bg-input/30';

/** The editor: a realm being added (`editing` undefined) or changed (its name). */
type Editing = { editing?: string; draft: RealmDraft; environment?: boolean };

/** On or Off in words beside a switch: a switch alone reads either way in some themes. */
const State = ({ on }: { on: boolean }) => <span className={`text-xs font-medium ${on ? 'text-foreground' : 'text-muted-foreground'}`}>{on ? 'On' : 'Off'}</span>;

/** The realm types the other ways to sign in offer: every one but GitHub, which has its own place. */
const OTHER_TYPES = REALM_TYPE_LABELS.filter((t) => t.type !== 'github');

export function Realms() {
  const canAdmin = useCanAdminInstance();
  const [view, setView] = useState<RealmsView | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // GET /api/realms answers an admin session (or loopback without one): nobody else reads it.
  useEffect(() => {
    if (!canAdmin) return;
    void get<RealmsView>('/api/realms').then(setView, (e: unknown) => toast.error((e as Error).message));
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

  if (!canAdmin) return <Panel title="Sign-in" icon={KeyRound}><Empty>Only the hopper's admins manage sign-in.</Empty></Panel>;
  if (!view) return <Panel title="Sign-in" icon={KeyRound}><Empty>Loading…</Empty></Panel>;
  const { version, githubAdmin } = view;
  // Each realm with its place in the whole list: a move names that place.
  const placed = view.realms.map((realm, at) => ({ realm, at }));
  const github = placed.filter((p) => p.realm.type === 'github');
  const others = placed.filter((p) => p.realm.type !== 'github');

  const save = async () => {
    if (!editing) return;
    const ok = await change({ action: 'save', realm: realmOf(editing.draft), version, ...(editing.editing === undefined ? {} : { name: editing.editing }) }, 'Saved: sign-in follows it now');
    if (ok) setEditing(null);
  };
  const editor = (group: 'github' | 'other') => editing && (group === 'github') === (editing.draft.type === 'github') && (
    <Editor editing={editing} setEditing={setEditing} error={error} busy={busy} onSave={() => void save()} onCancel={() => { setEditing(null); setError(null); }} />
  );
  const list = (group: typeof placed) => (
    <ul className="divide-y rounded-lg border">
      {group.map(({ realm: r }, i) => (
        <RealmRow key={r.name} realm={r} busy={busy || editing !== null}
          up={i === 0 ? undefined : group[i - 1]!.at} down={i === group.length - 1 ? undefined : group[i + 1]!.at}
          onEnable={(enabled) => void change({ action: 'enable', name: r.name, enabled, version })}
          onMove={(to) => void change({ action: 'move', name: r.name, to, version })}
          onEdit={() => { setError(null); setEditing({ editing: r.name, draft: draftOf(r), ...(r.environment ? { environment: true } : {}) }); }}
          onRemove={() => void change({ action: 'remove', name: r.name, version }, `${r.label} removed`)} />
      ))}
    </ul>
  );

  return (
    <div className="space-y-3">
      <Panel title="GitHub" icon={KeyRound}>
        <div data-section="github" className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            People sign in with GitHub, through this hopper's GitHub app. Signing in also connects their GitHub: it is what their jobs work through.
          </p>
          <p data-github-admin>
            {githubAdmin
              ? githubAdmin.user
                ? <><span className="font-medium">{githubAdmin.user}</span> is the admin: the first to sign in with GitHub.</>
                : <>The admin is the first person who signed in with GitHub.</>
              : <>Nobody has signed in with GitHub yet: the first person who does becomes admin.</>}
          </p>
          {editor('github')}
          {github.length === 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground">GitHub sign-in is not set up: nobody can sign in with GitHub.</span>
              <Button size="xs" variant="outline" className="gap-1" disabled={busy}
                onClick={() => void change({ action: 'save', realm: { name: 'github', label: 'GitHub', type: 'github' }, version }, 'GitHub sign-in added')}><Plus />Add GitHub sign-in</Button>
            </div>
          ) : list(github)}
        </div>
      </Panel>
      <Admins view={view} busy={busy} change={change} />
      <Panel title="Other ways to sign in" icon={Users} count={others.length}
        action={!editing ? <Button size="xs" variant="outline" className="gap-1" onClick={() => { setError(null); setEditing({ draft: emptyDraft('oidc') }); }}><Plus />Add realm</Button> : undefined}>
        <div data-section="other" className="space-y-3 text-sm">
          <p className="text-muted-foreground">
            Optional, for company accounts: an identity provider (OpenID Connect or SAML: a sign-in button each), a company directory (LDAP or Active Directory), or an auth gateway in front of the hopper that already signed people in. Whoever signs in one of these ways still connects their GitHub in Sources: it is what their jobs work through. Buttons are shown, and directories tried, in this order.
          </p>
          {editor('other')}
          {others.length === 0 ? <Empty>None: GitHub is the only way to sign in.</Empty> : list(others)}
        </div>
      </Panel>
      <Panel title="Device links" icon={Link}>
        <div data-section="device-links" className="text-sm">
          <label className="flex items-start gap-2">
            <Switch checked={view.local} disabled={busy} aria-label="Device links" className="mt-0.5" onCheckedChange={(local) => void change({ action: 'settings', local, version })} />
            <span className="mt-0.5"><State on={view.local} /></span>
            <span className="text-muted-foreground">
              Someone signed in can open the hopper on another device with a one-time link or QR code, and an admin can give a new user a link that signs them in. Each link works once, for 10 minutes, and signs in as admin of that one user. Off: neither works.
            </span>
          </label>
        </div>
      </Panel>
      <Panel title="No sign-in" icon={ShieldOff}>
        <div data-section="no-sign-in" className="flex flex-wrap items-center gap-2 text-sm">
          <select aria-label="No sign-in" className={SELECT} value={view.none ?? ''} disabled={busy}
            onChange={(e) => void change({ action: 'settings', none: e.target.value === '' ? null : e.target.value as UiRole, version })}>
            <option value="">Off</option>
            <option value="viewer">anyone may look (viewer)</option>
            <option value="operator">anyone may act on jobs (operator)</option>
            <option value="admin">anyone may change everything (admin)</option>
          </select>
          <span className="text-muted-foreground">Anyone who reaches the hopper gets in without signing in. Only for a hopper behind a proxy or network that already decides who gets in, and only while it has one user.</span>
        </div>
      </Panel>
    </div>
  );
}

function RealmRow({ realm: r, busy, up, down, onEnable, onMove, onEdit, onRemove }: {
  realm: RealmView; busy: boolean;
  /** The place in the whole list to move to: the one before or after it among its own; undefined at an end. */
  up: number | undefined; down: number | undefined;
  onEnable: (enabled: boolean) => void; onMove: (to: number) => void; onEdit: () => void; onRemove: () => void;
}) {
  const copy = (l: string) => navigator.clipboard?.writeText(l).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  const github = r.type === 'github';
  const who = whoGetsIn(r.settings);
  const single = up === undefined && down === undefined;
  return (
    <li data-realm={r.name} className="space-y-1 px-3 py-2 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Switch checked={r.enabled} disabled={busy} aria-label={`${r.label} on`} onCheckedChange={onEnable} />
        <State on={r.enabled} />
        <span className="min-w-0 truncate font-medium">{r.label}</span>
        {!github && <StatusBadge status={REALM_TYPE_SHORT[r.type]} tone="muted" />}
        {r.environment && <span className="text-xs text-muted-foreground" title="HOPPER_SIGN_IN_REALM_* variables set it up: a change here lasts until the next start">set from the environment</span>}
        <span className="ml-auto flex items-center gap-0.5">
          {!single && <>
            <Button variant="ghost" size="icon-xs" aria-label="Move up" disabled={busy || up === undefined} onClick={() => onMove(up!)}><ArrowUp /></Button>
            <Button variant="ghost" size="icon-xs" aria-label="Move down" disabled={busy || down === undefined} onClick={() => onMove(down!)}><ArrowDown /></Button>
          </>}
          <Button variant="ghost" size="icon-xs" aria-label="Edit" disabled={busy} onClick={onEdit}><Pencil /></Button>
          <Confirm title={`Remove ${r.label}?`} action="Remove" onConfirm={onRemove}
            description={`People who signed in with it are signed out at once, and nobody can sign in with it any more.`}>
            <Button variant="ghost" size="icon-xs" aria-label="Remove" disabled={busy}><Trash2 /></Button>
          </Confirm>
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {github ? 'Who else gets in' : 'Who gets in'}: {[...who.rules, `anyone else ${who.anyoneElse ? `gets ${who.anyoneElse}` : 'cannot sign in'}`].join(' · ')}
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

const LABEL = 'grid gap-1 text-xs';

function SecretInput({ f, value, stored, disabled, set }: { f: RealmField; value: string | null | undefined; stored: boolean; disabled: boolean; set: (v: string | null) => void }) {
  const removing = value === null;
  const placeholder = removing ? 'removed when saved' : stored ? 'set — empty keeps it' : 'not set';
  return (
    <label className={LABEL}>
      <span className="font-medium">{f.label}</span>
      <span className="flex items-center gap-1">
        <Input aria-label={f.label} type="password" autoComplete="new-password" spellCheck={false} className="font-mono text-xs" placeholder={placeholder}
          value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => set(e.target.value)} />
        {stored && !removing && (
          <Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${f.label.toLowerCase()}`} disabled={disabled} onClick={() => set(null)}><X /></Button>
        )}
      </span>
      <span className="text-muted-foreground">stored by the hopper, never shown again{f.help ? `; ${f.help}` : ''}</span>
    </label>
  );
}

function FieldInput({ f, value, disabled, set }: { f: RealmField; value: string | boolean | null | undefined; disabled: boolean; set: (v: string | boolean) => void }) {
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
      <div className="text-xs"><span className="font-medium">Role rules</span> <span className="text-muted-foreground">— the highest role a rule grants wins; someone no rule matches gets the default role.{draft.type === 'github' ? ' The first person to sign in with GitHub is admin whatever the rules say.' : ''}</span></div>
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
            {OTHER_TYPES.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
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
        {REALM_FIELDS[draft.type].map((f) => (f.kind === 'secret'
          ? <SecretInput key={f.path} f={f} value={draft.values[f.path] as string | null | undefined} stored={draft.secrets.includes(f.path)} disabled={busy}
              set={(v) => set({ ...draft, values: { ...draft.values, [f.path]: v } })} />
          : <FieldInput key={f.path} f={f} value={draft.values[f.path]} disabled={busy} set={(v) => set({ ...draft, values: { ...draft.values, [f.path]: v } })} />))}
        <RoleRules draft={draft} set={set} disabled={busy} />
      </div>
      <p className="text-xs text-muted-foreground">Every setting: docs/sign-in.md in the hopper's install.{editing.environment ? ' This realm is set up by the environment: the next start sets it from there again.' : ''}</p>
      {error && <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-2 py-1.5 text-xs text-destructive">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !draft.name.trim()}>Save</Button>
        <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
