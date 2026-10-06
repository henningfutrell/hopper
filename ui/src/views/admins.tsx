// Settings → Sign-in → Admins (issue #242): everyone who has signed in, each with their role and whether
// they are a super admin. Any admin makes someone admin; a super admin also makes them super admin, or
// hands their own over (they stay admin). A regular admin is offered neither. The changes are the Sign-in
// page's (POST /ui/api/realms); this only shows the people and asks.
import { Crown, ShieldCheck } from 'lucide-react';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import type { PersonView, RealmsEdit, RealmsView } from '@/model/wire';
import { useHopper } from '@/store';

/** Everyone who has signed in, with their role; making them admin, or super admin (a super admin only). */
export function Admins({ view: { people, realms, version }, busy, change }: {
  view: RealmsView; busy: boolean;
  /** The Sign-in page's one change, with the toast on success. */
  change: (edit: RealmsEdit, done?: string) => Promise<boolean>;
}) {
  const superAdmin = useHopper((st) => st.user?.superAdmin === true);
  const who = (p: PersonView) => ({ realm: p.realm, subject: p.subject });
  const onAdmin = (p: PersonView) => void change({ action: 'admin', who: who(p), version }, `${p.user} is admin now`);
  const onSuperAdmin = (p: PersonView, transfer: boolean) => void change({ action: 'super-admin', who: who(p), ...(transfer ? { transfer } : {}), version },
    transfer ? `${p.user} is super admin now; you stay admin` : `${p.user} is super admin now`);
  const label = (realm: string) => realms.find((r) => r.name === realm)?.label ?? realm;
  return (
    <Panel title="Admins" icon={ShieldCheck} count={people.filter((p) => p.role === 'admin').length}>
      <div data-section="admins" className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          An admin can make anyone who has signed in admin. A super admin can also make them super admin, or hand their own super admin over and stay admin. The first person to sign in with GitHub is a super admin.
          {!superAdmin && ' You are not a super admin: only a super admin makes someone super admin.'}
        </p>
        {people.length === 0 ? <Empty>Nobody has signed in yet.</Empty> : (
          <ul className="divide-y rounded-lg border">
            {people.map((p) => (
              <li key={`${p.realm} ${p.subject}`} data-person={p.user} className="flex min-w-0 flex-wrap items-center gap-2 px-3 py-2">
                <span className="min-w-0 truncate font-medium">{p.user}</span>
                <span className="text-xs text-muted-foreground">{label(p.realm)}</span>
                {p.superAdmin ? <StatusBadge status="super admin" tone="ok" /> : <StatusBadge status={p.role ?? 'no role'} tone={p.role === 'admin' ? 'ok' : 'muted'} />}
                <span className="ml-auto flex flex-wrap items-center gap-1">
                  {p.role !== 'admin' && <Button size="xs" variant="outline" disabled={busy} onClick={() => onAdmin(p)}>Make admin</Button>}
                  {superAdmin && !p.superAdmin && <>
                    <Button size="xs" variant="outline" className="gap-1" disabled={busy} onClick={() => onSuperAdmin(p, false)}><Crown />Make super admin</Button>
                    <Confirm title={`Hand super admin over to ${p.user}?`} action="Hand over" onConfirm={() => onSuperAdmin(p, true)}
                      description={`${p.user} becomes super admin. You stay admin, but no longer super admin.`}>
                      <Button size="xs" variant="outline" disabled={busy}>Hand over super admin</Button>
                    </Confirm>
                  </>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
