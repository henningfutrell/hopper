// Settings (issue #151): the configuration plane, one view with a section per part — the version (issue #165)
// and the version history (issue #246) first (issue #363), then the question gates (escalation levels, standing rules,
// risk rules), the question history, the decider (issue #550; named Decider in issue #661), auto-park (issue #650), the job rules (issue #172), yolo mode (issue #579), artifacts (issue #624), routing, plugins, webhooks, the vault (issue #558), the users (issue #158),
// sign-in (issue #185), access and its permission matrix (issue #559) — each routed by hash (#settings/routing), so a link and the back button work. #settings
// alone opens the version. A moved section's old hash (#settings/minor-decisions) is replaced by its new one.
import { CirclePause, FolderOpen, Grid3x3, History, Info, KeyRound, KeySquare, ListChecks, LockKeyhole, Puzzle, Route, Scale, ScrollText, ShieldCheck, Users as UsersIcon, Webhook, Zap, type LucideIcon } from 'lucide-react';
import { useEffect } from 'react';
import { useSection } from '@/app/nav';
import { VersionDetails } from '@/app/update';
import { cn } from '@/lib/utils';
import { Access } from '@/views/access';
import { ArtifactSettings } from '@/views/artifact-settings';
import { AutoPark } from '@/views/auto-park';
import { JobRules } from '@/views/job-rules';
import { MinorDecisions } from '@/views/minor-decisions';
import { PermissionMatrix } from '@/views/permission-matrix';
import { Plugins } from '@/views/plugins';
import { QuestionGates } from '@/views/question-gates';
import { QuestionHistory } from '@/views/question-history';
import { Realms } from '@/views/realms';
import { Routing } from '@/views/routing';
import { Users } from '@/views/users';
import { Vault } from '@/views/vault';
import { VersionHistory } from '@/views/version-history';
import { Webhooks } from '@/views/webhooks';
import { YoloMode } from '@/views/yolo-mode';

const SECTIONS = ['version', 'version-history', 'questions', 'history', 'decider', 'auto-park', 'job-rules', 'yolo-mode', 'artifacts', 'routing', 'plugins', 'webhooks', 'vault', 'users', 'sign-in', 'access', 'permissions'] as const;
type Section = (typeof SECTIONS)[number];
const ITEMS: Record<Section, { label: string; icon: LucideIcon; view: () => React.ReactNode }> = {
  version: { label: 'Version', icon: Info, view: Version },
  'version-history': { label: 'Version history', icon: ScrollText, view: VersionHistory },
  questions: { label: 'Question gates', icon: ShieldCheck, view: QuestionGates },
  history: { label: 'Question history', icon: History, view: QuestionHistory },
  decider: { label: 'Decider', icon: Scale, view: MinorDecisions },
  'auto-park': { label: 'Auto-park', icon: CirclePause, view: AutoPark },
  'job-rules': { label: 'Job rules', icon: ListChecks, view: JobRules },
  'yolo-mode': { label: 'Yolo mode', icon: Zap, view: YoloMode },
  artifacts: { label: 'Artifacts', icon: FolderOpen, view: ArtifactSettings },
  routing: { label: 'Routing', icon: Route, view: Routing },
  plugins: { label: 'Plugins', icon: Puzzle, view: Plugins },
  webhooks: { label: 'Webhooks', icon: Webhook, view: Webhooks },
  vault: { label: 'Vault', icon: LockKeyhole, view: Vault },
  users: { label: 'Users', icon: UsersIcon, view: Users },
  'sign-in': { label: 'Sign-in', icon: KeyRound, view: Realms },
  access: { label: 'Access', icon: KeySquare, view: Access },
  permissions: { label: 'Permission matrix', icon: Grid3x3, view: PermissionMatrix },
};

function Version() {
  return <section className="max-w-xl rounded-lg border p-4"><h2 className="mb-3 text-sm font-medium">Version and updates</h2><VersionDetails /></section>;
}

/** Old section names and the section each moved to, so an old link still opens it. */
const MOVED: Record<string, Section> = { 'minor-decisions': 'decider' };
const sectionOf = (s: string): Section => MOVED[s] ?? ((SECTIONS as readonly string[]).includes(s) ? (s as Section) : 'version');

export function Settings() {
  const raw = useSection();
  const section = sectionOf(raw);
  useEffect(() => { const to = MOVED[raw]; if (to) window.location.replace(`#settings/${to}`); }, [raw]);
  const Current = ITEMS[section].view;
  return (
    <div className="space-y-3">
      <nav data-slot="settings-nav" aria-label="Settings sections" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {SECTIONS.map((s) => {
          const { label, icon: Icon } = ITEMS[s];
          return (
            <a key={s} href={`#settings/${s}`} aria-current={section === s ? 'page' : undefined}
              className={cn('flex h-9 shrink-0 items-center gap-2 rounded-md border px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
                section === s && 'border-foreground/20 bg-muted text-foreground')}>
              <Icon className="size-4" />{label}
            </a>
          );
        })}
      </nav>
      <Current />
    </div>
  );
}
