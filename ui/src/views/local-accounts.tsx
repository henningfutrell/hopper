// Settings → Sign-in → Local accounts (issue #1380): the hopper's own sign-in, an email and a password, for a hopper with
// no identity provider. An admin adds one (email, role, password), changes its role or sets its password, or removes it
// (GET /api/local-accounts, POST /ui/api/local-accounts). The daemon refuses to set the password of an account that signs
// in as another user, and to remove or lower the account you signed in with. Your password (`OwnPassword`): a session
// signed in with a local account changes its own password (POST /ui/api/local-accounts/password).
import { AtSign, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { get, post, SessionRejected } from '@/lib/api';
import type { LocalAccountsEdit, LocalAccountsView, LocalAccountView, UiRole } from '@/model/wire';
import { useHopper } from '@/store';

const SELECT = 'h-8 rounded-lg border border-input bg-transparent px-2 text-base md:text-sm dark:bg-input/30';
const ROLES: UiRole[] = ['viewer', 'operator', 'admin'];
/** The realm a local account signs in through (src/auth/local-accounts.ts). */
const LOCAL_ACCOUNTS_REALM = 'local-accounts';
const MIN_PASSWORD = 12;

/** The local accounts, for an instance admin. */
export function LocalAccounts() {
  const [view, setView] = useState<LocalAccountsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  useEffect(() => { void get<LocalAccountsView>('/api/local-accounts').then(setView, (e: unknown) => toast.error((e as Error).message)); }, []);

  const change = async (edit: LocalAccountsEdit, done: string): Promise<boolean> => {
    setBusy(true);
    try {
      setView(await post<LocalAccountsView>('/ui/api/local-accounts', edit));
      toast.success(done);
      return true;
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((err as Error).message);
      return false;
    } finally { setBusy(false); }
  };

  return (
    <Panel title="Local accounts" icon={AtSign} count={view?.accounts.length}
      action={!adding ? <Button size="xs" variant="outline" className="gap-1" onClick={() => setAdding(true)}><Plus />Add account</Button> : undefined}>
      <div data-section="local-accounts" className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          The hopper's own accounts: an email and a password, no identity provider needed. People sign in with them on the sign-in page. Each account has its own role. The hopper keeps only a hash of each password.
        </p>
        {adding && <AccountForm busy={busy} onCancel={() => setAdding(false)}
          onSave={async (edit) => { if (await change(edit, `${edit.email} added`)) setAdding(false); }} />}
        {!view ? <Empty>Loading…</Empty> : view.accounts.length === 0 ? <Empty>None.</Empty> : (
          <ul className="divide-y rounded-lg border">
            {view.accounts.map((a) => <AccountRow key={a.email} account={a} busy={busy} change={change} />)}
          </ul>
        )}
      </div>
    </Panel>
  );
}

function AccountRow({ account: a, busy, change }: { account: LocalAccountView; busy: boolean; change: (edit: LocalAccountsEdit, done: string) => Promise<boolean> }) {
  const [password, setPassword] = useState<string | null>(null);
  return (
    <li data-account={a.email} className="space-y-2 px-3 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-medium">{a.email}</span>
        {a.user && <span className="text-xs text-muted-foreground">user {a.user}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          <select aria-label={`Role of ${a.email}`} className={SELECT} value={a.role} disabled={busy}
            onChange={(e) => void change({ action: 'save', email: a.email, role: e.target.value as UiRole }, `${a.email} is ${e.target.value} now`)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <Button size="xs" variant="outline" className="gap-1" disabled={busy} onClick={() => setPassword(password === null ? '' : null)}><KeyRound />Set password</Button>
          <Confirm title={`Remove ${a.email}?`} action="Remove" onConfirm={() => void change({ action: 'remove', email: a.email }, `${a.email} removed`)}
            description="Its sessions end at once, and nobody can sign in with it any more. The user it signed in as and their work stay.">
            <Button variant="ghost" size="icon-xs" aria-label="Remove" disabled={busy}><Trash2 /></Button>
          </Confirm>
        </span>
      </div>
      {password !== null && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => {
          e.preventDefault();
          void change({ action: 'save', email: a.email, role: a.role, password }, `The password of ${a.email} is set; its sessions ended`).then((ok) => ok && setPassword(null));
        }}>
          <Input aria-label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`New password (${MIN_PASSWORD} characters at least)`} className="h-8 max-w-xs" />
          <Button size="xs" type="submit" disabled={busy || password.length < MIN_PASSWORD}>Save</Button>
          <Button size="xs" variant="ghost" type="button" onClick={() => setPassword(null)}>Cancel</Button>
        </form>
      )}
    </li>
  );
}

function AccountForm({ busy, onSave, onCancel }: { busy: boolean; onSave: (edit: Extract<LocalAccountsEdit, { action: 'save' }>) => Promise<void>; onCancel: () => void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<UiRole>('operator');
  const [password, setPassword] = useState('');
  const ready = email.includes('@') && password.length >= MIN_PASSWORD;
  return (
    <form data-account-form className="flex flex-wrap items-center gap-2 rounded-lg border p-3" onSubmit={(e) => { e.preventDefault(); if (ready) void onSave({ action: 'save', email: email.trim(), role, password }); }}>
      <Input aria-label="Email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" className="h-8 max-w-xs" />
      <select aria-label="Role" className={SELECT} value={role} onChange={(e) => setRole(e.target.value as UiRole)}>
        {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
      </select>
      <Input aria-label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`Password (${MIN_PASSWORD} characters at least)`} className="h-8 max-w-xs" />
      <Button size="xs" type="submit" disabled={busy || !ready}>Add</Button>
      <Button size="xs" variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
    </form>
  );
}

/** Your own password, for a session signed in with a local account; nothing for another session. */
export function OwnPassword() {
  const own = useHopper((st) => st.user?.realm === LOCAL_ACCOUNTS_REALM);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await post('/ui/api/local-accounts/password', { current, password });
      toast.success('Password changed: your other sessions ended');
      setCurrent(''); setPassword('');
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((err as Error).message);
    } finally { setBusy(false); }
  };
  if (!own) return null;
  return (
    <Panel title="Your password" icon={KeyRound}>
      <form data-section="own-password" className="flex flex-wrap items-center gap-2 text-sm" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Input aria-label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Current password" className="h-8 max-w-xs" />
        <Input aria-label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={`New password (${MIN_PASSWORD} characters at least)`} className="h-8 max-w-xs" />
        <Button size="xs" type="submit" disabled={busy || !current || password.length < MIN_PASSWORD}>Change password</Button>
      </form>
    </Panel>
  );
}
