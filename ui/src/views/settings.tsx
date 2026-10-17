// Settings (issue #151): the configuration plane, one view with a section per part — the version (issue #165) with this hopper's display name (issue #465)
// and the version history (issue #246) first (issue #363), then the question gates (escalation levels, standing rules,
// risk rules), the decider (issue #550; named Decider in issue #661), auto-park (issue #650), preemption (issue #1525), the issue thread (issue #435), the TL;DR (issue #569), the job rules (issue #172), the intake's trusted actors (issue #652), yolo mode (issue #579), landing batches (issue #1073), the host link base (issue #712), the GitHub rate limit (issue #436), the GitHub webhook (issue #1079), remote access (issue #880), the allowed hosts (issue #1024), Contribution (issue #429), GitHub watches (issue #427), artifacts (issue #624), routing, plugins, webhooks, the vault (issue #558), the users (issue #158),
// sign-in (issue #185), API tokens (issue #718), access and its permission matrix (issue #559) — each routed by hash (#settings/routing), so a link and the back button work. #settings
// alone opens the version. A moved section's old hash (#settings/minor-decisions) is replaced by its new one. Settings holds configuration only
// (issue #897): the question history moved to Questions (#questions/history) and Your reports to its own view (#reports); their old hashes open them.
import { ArrowUpFromLine, CirclePause, Cloud, Eye, FileWarning, FolderOpen, Gauge, GitFork, GitPullRequestArrow, Globe, Grid3x3, Info, KeyRound, Layers, KeySquare, Link, ListChecks, LockKeyhole, MessagesSquare, MonitorCog, Network, Puzzle, Radar, Route, Scale, ScrollText, ShieldCheck, TextQuote, Ticket, type LucideIcon, UserCheck, Users as UsersIcon, Webhook, Zap } from 'lucide-react';
import { useEffect } from 'react';
import { useSection } from '@/app/nav';
import { VersionDetails } from '@/app/update';
import { cn } from '@/lib/utils';
import { Access } from '@/views/access';
import { ApiTokens } from '@/views/api-tokens';
import { ArtifactSettings } from '@/views/artifact-settings';
import { AllowedHosts } from '@/views/allowed-hosts';
import { AutoPark } from '@/views/auto-park';
import { Preemption } from '@/views/preemption';
import { GitHubRateLimiter } from '@/views/github-rate-limiter';
import { GitHubDeliveries } from '@/views/github-deliveries';
import { Contribution } from '@/views/contribution';
import { DisplayName } from '@/views/display-name';
import { ShrinkGuard } from '@/views/shrink-guard';
import { GitHubWatches } from '@/views/github-watches';
import { ComponentWatchers } from '@/views/component-watchers';
import { JobRules } from '@/views/job-rules';
import { MinorDecisions } from '@/views/minor-decisions';
import { PermissionMatrix } from '@/views/permission-matrix';
import { Plugins } from '@/views/plugins';
import { QuestionGates } from '@/views/question-gates';
import { Realms } from '@/views/realms';
import { RemoteAccess } from '@/views/remote-access';
import { HostLink } from '@/views/host-link';
import { Routing } from '@/views/routing';
import { ThreadAsk } from '@/views/thread-ask';
import { TldrSettings } from '@/views/tldr-settings';
import { Users } from '@/views/users';
import { Vault } from '@/views/vault';
import { VersionHistory } from '@/views/version-history';
import { Webhooks } from '@/views/webhooks';
import { WindowsHosts } from '@/views/windows-hosts';
import { YoloMode } from '@/views/yolo-mode';
import { LandingBatches } from '@/views/landing-batches';
import { IntakeActors } from '@/views/intake-actors';
import { CloudLink } from '@/views/cloud-link';

const SECTIONS = ['version', 'version-history', 'questions', 'decider', 'auto-park', 'preemption', 'thread-ask', 'tldr', 'job-rules', 'windows-hosts', 'intake', 'yolo-mode', 'landing-batches', 'github-rate-limit', 'github-webhook', 'remote-access', 'allowed-hosts', 'host-link', 'cloud-link', 'contribution', 'shrink-guard', 'github-watches', 'component-watchers', 'artifacts', 'routing', 'plugins', 'webhooks', 'vault', 'users', 'sign-in', 'api-tokens', 'access', 'permissions'] as const;
type Section = (typeof SECTIONS)[number];
const ITEMS: Record<Section, { label: string; icon: LucideIcon; view: () => React.ReactNode }> = {
  version: { label: 'Version', icon: Info, view: Version },
  'version-history': { label: 'Version history', icon: ScrollText, view: VersionHistory },
  questions: { label: 'Question gates', icon: ShieldCheck, view: QuestionGates },
  decider: { label: 'Decider', icon: Scale, view: MinorDecisions },
  'auto-park': { label: 'Auto-park', icon: CirclePause, view: AutoPark },
  preemption: { label: 'Preemption', icon: ArrowUpFromLine, view: Preemption },
  'thread-ask': { label: 'Issue thread', icon: MessagesSquare, view: ThreadAsk },
  tldr: { label: 'TL;DR', icon: TextQuote, view: TldrSettings },
  'job-rules': { label: 'Job rules', icon: ListChecks, view: JobRules },
  'windows-hosts': { label: 'Windows hosts', icon: MonitorCog, view: WindowsHosts },
  intake: { label: 'Intake', icon: UserCheck, view: IntakeActors },
  'yolo-mode': { label: 'Yolo mode', icon: Zap, view: YoloMode },
  'landing-batches': { label: 'Landing batches', icon: Layers, view: LandingBatches },
  'github-rate-limit': { label: 'GitHub rate limit', icon: Gauge, view: GitHubRateLimiter },
  'github-webhook': { label: 'GitHub webhook', icon: GitPullRequestArrow, view: GitHubDeliveries },
  'remote-access': { label: 'Remote access', icon: Globe, view: RemoteAccess },
  'allowed-hosts': { label: 'Allowed hosts', icon: Network, view: AllowedHosts },
  'host-link': { label: 'Host link', icon: Link, view: HostLink },
  'cloud-link': { label: 'hopper.io', icon: Cloud, view: CloudLink },
  contribution: { label: 'Contribution', icon: GitFork, view: Contribution },
  'shrink-guard': { label: 'Shrink guard', icon: FileWarning, view: ShrinkGuard },
  'github-watches': { label: 'GitHub watches', icon: Eye, view: GitHubWatches },
  'component-watchers': { label: 'Component watchers', icon: Radar, view: ComponentWatchers },
  artifacts: { label: 'Artifacts', icon: FolderOpen, view: ArtifactSettings },
  routing: { label: 'Routing', icon: Route, view: Routing },
  plugins: { label: 'Plugins', icon: Puzzle, view: Plugins },
  webhooks: { label: 'Webhooks', icon: Webhook, view: Webhooks },
  vault: { label: 'Vault', icon: LockKeyhole, view: Vault },
  users: { label: 'Users', icon: UsersIcon, view: Users },
  'sign-in': { label: 'Sign-in', icon: KeyRound, view: Realms },
  'api-tokens': { label: 'API tokens', icon: Ticket, view: ApiTokens },
  access: { label: 'Access', icon: KeySquare, view: Access },
  permissions: { label: 'Permission matrix', icon: Grid3x3, view: PermissionMatrix },
};

function Version() {
  return <div className="space-y-3"><section className="max-w-xl rounded-lg border p-4"><h2 className="mb-3 text-sm font-medium">Version and updates</h2><VersionDetails /></section><DisplayName /></div>;
}

/** Old section names and the section each moved to, so an old link still opens it. */
const MOVED: Record<string, Section> = { 'minor-decisions': 'decider' };
/** Old sections that left Settings (issue #897), and the hash of their one home now. */
const LEFT: Record<string, string> = { history: '#questions/history', reports: '#reports' };
const sectionOf = (s: string): Section => MOVED[s] ?? ((SECTIONS as readonly string[]).includes(s) ? (s as Section) : 'version');

export function Settings() {
  const raw = useSection();
  const section = sectionOf(raw);
  useEffect(() => {
    const to = MOVED[raw];
    if (to) window.location.replace(`#settings/${to}`);
    else if (LEFT[raw]) window.location.replace(LEFT[raw]);
  }, [raw]);
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
