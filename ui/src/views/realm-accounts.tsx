// A password realm's accounts (issue #200), under its row in Settings → Sign-in: username, role and the
// user each signs in as; an account added with its password, role and user, its role changed, given a
// new password, or removed. The password goes to the daemon, which keeps only its argon2id hash. An
// admin never gets a way into another user's work (issue #221): an account is linked only to the admin's
// own user, and only its own user gives a new password to an account that signs in as another user.
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Confirm } from '@/components/confirm';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { PasswordAccountView, RealmsEdit, UiRole, UserView } from '@/model/wire';
import { useHopper } from '@/store';

export const SELECT = 'h-8 rounded-lg border border-input bg-transparent px-2 text-base md:text-sm dark:bg-input/30';
const ROLES: UiRole[] = ['viewer', 'operator', 'admin'];

/** One change without its version: the view adds the version it read. */
export type AccountChange = Extract<RealmsEdit, { action: 'account' | 'account-remove' }> extends infer E ? E extends unknown ? Omit<E, 'version'> : never : never;

export function RealmAccounts({ realm, accounts, users, busy, change }: {
  realm: string; accounts: PasswordAccountView[]; users: UserView[]; busy: boolean; change: (c: AccountChange, done?: string) => Promise<boolean>;
}) {
  const me = useHopper((s) => s.user?.id);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ username: '', password: '', role: 'viewer' as UiRole, user: '' });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const { username, password, role, user } = draft;
    if (await change({ action: 'account', realm, username: username.trim(), password, role, ...(user === '' ? {} : { user }) }, `${username.trim()} added`)) {
      setAdding(false);
      setDraft({ username: '', password: '', role: 'viewer', user: '' });
    }
  };

  return (
    <div className="space-y-2 pl-1">
      {accounts.length === 0
        ? <p className="text-xs text-muted-foreground">No accounts yet: add one, and the username and password form signs people in with it.</p>
        : (
          <ul className="divide-y rounded-md border">
            {accounts.map((a) => <AccountRow key={a.username} realm={realm} account={a} mine={a.user === undefined || a.user.id === me} busy={busy} change={change} />)}
          </ul>
        )}
      {adding ? (
        <form className="flex flex-wrap items-end gap-2 rounded-md border p-2" onSubmit={(e) => void add(e)}>
          <Input aria-label="Username" placeholder="username" className="w-36" autoComplete="off" value={draft.username} disabled={busy}
            onChange={(e) => setDraft({ ...draft, username: e.target.value })} />
          <Input aria-label="Password" type="password" placeholder="password (8 or more)" className="w-44" autoComplete="new-password" value={draft.password} disabled={busy}
            onChange={(e) => setDraft({ ...draft, password: e.target.value })} />
          <select aria-label="Role" className={SELECT} value={draft.role} disabled={busy} onChange={(e) => setDraft({ ...draft, role: e.target.value as UiRole })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <select aria-label="Signs in as" className={SELECT} value={draft.user} disabled={busy} onChange={(e) => setDraft({ ...draft, user: e.target.value })}>
            <option value="">a new user of its own</option>
            {users.filter((u) => u.id === me).map((u) => <option key={u.id} value={u.id}>{u.name} (you)</option>)}
          </select>
          <Button type="submit" size="sm" disabled={busy || !draft.username.trim() || draft.password.length < 8}>Add</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setAdding(false)}>Cancel</Button>
        </form>
      ) : (
        <Button size="xs" variant="outline" className="gap-1" disabled={busy} onClick={() => setAdding(true)}><Plus />Add account</Button>
      )}
    </div>
  );
}

function AccountRow({ realm, account: a, mine, busy, change }: {
  realm: string; account: PasswordAccountView; mine: boolean; busy: boolean; change: (c: AccountChange, done?: string) => Promise<boolean>;
}) {
  const [password, setPassword] = useState<string | null>(null);
  const setNew = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password !== null && await change({ action: 'account', realm, username: a.username, role: a.role, password }, `New password for ${a.username}`)) setPassword(null);
  };
  return (
    <li data-account={a.username} className="space-y-1 px-2 py-1.5 text-sm">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 truncate font-medium">{a.username}</span>
        <span className="truncate text-xs text-muted-foreground">{a.user ? `signs in as ${a.user.name}` : 'a new user at its first sign-in'}</span>
        <span className="ml-auto flex items-center gap-1">
          <select aria-label={`${a.username} role`} className={SELECT} value={a.role} disabled={busy}
            onChange={(e) => void change({ action: 'account', realm, username: a.username, role: e.target.value as UiRole })}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {mine
            ? <Button variant="ghost" size="icon-xs" aria-label="New password" title="New password" disabled={busy} onClick={() => setPassword('')}><KeyRound /></Button>
            : <span className="text-xs text-muted-foreground" title="Only they change it, under Settings → Users">their password</span>}
          <Confirm title={`Remove ${a.username}?`} action="Remove" onConfirm={() => void change({ action: 'account-remove', realm, username: a.username }, `${a.username} removed`)}
            description="Signed out at once; the account signs in no more. The user it signed in as, and their work, stay.">
            <Button variant="ghost" size="icon-xs" aria-label={`Remove ${a.username}`} disabled={busy}><Trash2 /></Button>
          </Confirm>
        </span>
      </div>
      {password !== null && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => void setNew(e)}>
          <Input aria-label={`New password for ${a.username}`} type="password" placeholder="new password (8 or more)" className="w-52" autoComplete="new-password"
            value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" size="sm" disabled={busy || password.length < 8}>Set</Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setPassword(null)}>Cancel</Button>
        </form>
      )}
    </li>
  );
}
