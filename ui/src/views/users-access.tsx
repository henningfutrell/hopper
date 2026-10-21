// Users & access (issue #2373): a view of its own, out of Settings, which keeps configuration only. It holds what a person
// acts in to say who may do what — the users, Access with Try a check, the permission matrix and the API tokens —, each a
// section routed by hash (#users-access/api-tokens), so a link and the back button work. #users-access alone opens Users.
// A device grant's link (#users-access/api-tokens/<user code>) opens API tokens with that code.
import { Grid3x3, KeySquare, Ticket, type LucideIcon, Users as UsersIcon } from 'lucide-react';
import { useSection } from '@/app/nav';
import { cn } from '@/lib/utils';
import { Access } from '@/views/access';
import { ApiTokens } from '@/views/api-tokens';
import { PermissionMatrix } from '@/views/permission-matrix';
import { Users } from '@/views/users';

const SECTIONS = ['users', 'access', 'permissions', 'api-tokens'] as const;
type Section = (typeof SECTIONS)[number];
const ITEMS: Record<Section, { label: string; icon: LucideIcon; view: () => React.ReactNode }> = {
  users: { label: 'Users', icon: UsersIcon, view: Users },
  access: { label: 'Access', icon: KeySquare, view: Access },
  permissions: { label: 'Permission matrix', icon: Grid3x3, view: PermissionMatrix },
  'api-tokens': { label: 'API tokens', icon: Ticket, view: ApiTokens },
};

const sectionOf = (s: string): Section => ((SECTIONS as readonly string[]).includes(s) ? (s as Section) : 'users');

export function UsersAccess() {
  const section = sectionOf(useSection());
  const Current = ITEMS[section].view;
  return (
    <div className="space-y-3">
      <nav data-slot="users-access-nav" aria-label="Users & access sections" className="flex flex-wrap gap-1">
        {SECTIONS.map((s) => {
          const { label, icon: Icon } = ITEMS[s];
          return (
            <a key={s} href={`#users-access/${s}`} aria-current={s === section ? 'page' : undefined}
              className={cn('flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                s === section && 'border-foreground/20 bg-muted text-foreground')}>
              <Icon className="size-3.5" />{label}
            </a>
          );
        })}
      </nav>
      <Current />
    </div>
  );
}
