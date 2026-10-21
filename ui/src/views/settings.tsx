// Settings (issue #151): the configuration plane, one view with a section per part — the version (issue #165) with this hopper's display name (issue #465)
// and the version history (issue #246) first (issue #363), then the question gates (escalation levels, standing rules,
// risk rules), the decider (issue #550; named Decider in issue #661), the token budget (issue #2302), preemption (issue #1525), the issue thread (issue #435), the TL;DR (issue #569), the job rules (issue #172), the intake's trusted actors (issue #652), yolo mode (issue #579), landing batches (issue #1073), the host link base (issue #712), the GitHub rate limit (issue #436), the GitHub webhook (issue #1079), remote access (issue #880), the allowed hosts (issue #1024), Contribution (issue #429), GitHub watches (issue #427), artifacts (issue #624), routing, plugins, webhooks, the vault (issue #558), the users (issue #158),
// sign-in (issue #185), API tokens (issue #718), access and its permission matrix (issue #559) — each routed by hash (#settings/routing), so a link and the back button work. #settings
// alone opens the version. A moved section's old hash (#settings/minor-decisions) is replaced by its new one. Settings holds configuration only
// (issue #897): the question history moved to Questions (#questions/history) and Your reports to its own view (#reports); their old hashes open them.
// The sections' links are in groups that fold, with a jump list (issue #2353).
import { Activity, ArrowUpFromLine, Boxes, ChevronDown, ChevronRight, Cloud, Coins, Eye, FileWarning, FolderOpen, Gauge, GitFork, GitPullRequestArrow, Globe, Grid3x3, Info, KeyRound, Layers, KeySquare, Link, ListChecks, LockKeyhole, MessagesSquare, MonitorCog, Network, Puzzle, Radar, Route, Scale, ScrollText, ShieldCheck, TextQuote, Ticket, type LucideIcon, UserCheck, Users as UsersIcon, Webhook, Zap } from 'lucide-react';
import { useEffect } from 'react';
import { useSection } from '@/app/nav';
import { VersionDetails } from '@/app/update';
import { useGroupOpen } from '@/hooks/use-page-pref';
import { cn } from '@/lib/utils';
import { Access } from '@/views/access';
import { ApiTokens } from '@/views/api-tokens';
import { ArtifactSettings } from '@/views/artifact-settings';
import { AllowedHosts } from '@/views/allowed-hosts';
import { TelemetrySettings } from '@/views/telemetry-settings';
import { TokenBudget } from '@/views/token-budget';
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
import { Clusters } from '@/views/clusters';
import { YoloMode } from '@/views/yolo-mode';
import { LandingBatches } from '@/views/landing-batches';
import { IntakeActors } from '@/views/intake-actors';
import { CloudLink } from '@/views/cloud-link';

const SECTIONS = ['version', 'version-history', 'questions', 'decider', 'token-budget', 'preemption', 'thread-ask', 'tldr', 'job-rules', 'windows-hosts', 'intake', 'yolo-mode', 'landing-batches', 'github-rate-limit', 'github-webhook', 'remote-access', 'allowed-hosts', 'telemetry', 'host-link', 'cloud-link', 'contribution', 'shrink-guard', 'github-watches', 'component-watchers', 'artifacts', 'routing', 'plugins', 'webhooks', 'vault', 'clusters', 'users', 'sign-in', 'api-tokens', 'access', 'permissions'] as const;
type Section = (typeof SECTIONS)[number];
const ITEMS: Record<Section, { label: string; icon: LucideIcon; view: () => React.ReactNode }> = {
  version: { label: 'Version', icon: Info, view: Version },
  'version-history': { label: 'Version history', icon: ScrollText, view: VersionHistory },
  questions: { label: 'Question gates', icon: ShieldCheck, view: QuestionGates },
  decider: { label: 'Decider', icon: Scale, view: MinorDecisions },
  'token-budget': { label: 'Token budget', icon: Coins, view: TokenBudget },
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
  telemetry: { label: 'Telemetry', icon: Activity, view: TelemetrySettings },
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
  clusters: { label: 'Clusters', icon: Boxes, view: Clusters },
  users: { label: 'Users', icon: UsersIcon, view: Users },
  'sign-in': { label: 'Sign-in', icon: KeyRound, view: Realms },
  'api-tokens': { label: 'API tokens', icon: Ticket, view: ApiTokens },
  access: { label: 'Access', icon: KeySquare, view: Access },
  permissions: { label: 'Permission matrix', icon: Grid3x3, view: PermissionMatrix },
};

function Version() {
  return <div className="space-y-3"><section className="max-w-xl rounded-lg border p-4"><h2 className="mb-3 text-sm font-medium">Version and updates</h2><VersionDetails /></section><DisplayName /></div>;
}

/** The sections' links in groups (issue #2353): each group folds by its title, kept per browser; a folded group still shows
 * the link of the section open now. Every section is in one group. */
const GROUPS = [
  { id: 'general', label: 'General', sections: ['version', 'version-history', 'telemetry', 'cloud-link', 'artifacts'] },
  { id: 'questions', label: 'Questions', sections: ['questions', 'decider', 'thread-ask', 'tldr'] },
  { id: 'jobs', label: 'Jobs', sections: ['token-budget', 'preemption', 'job-rules', 'windows-hosts', 'clusters', 'routing', 'plugins'] },
  { id: 'github', label: 'GitHub', sections: ['intake', 'yolo-mode', 'landing-batches', 'github-rate-limit', 'github-webhook', 'contribution', 'shrink-guard', 'github-watches', 'component-watchers', 'webhooks'] },
  { id: 'network', label: 'Network', sections: ['remote-access', 'allowed-hosts', 'host-link'] },
  { id: 'access', label: 'Access', sections: ['vault', 'users', 'sign-in', 'api-tokens', 'access', 'permissions'] },
] as const satisfies readonly { id: string; label: string; sections: readonly Section[] }[];
type Group = { id: string; label: string; sections: readonly Section[] };
/** A section in no group fails the typecheck. */
const grouped: Exclude<Section, (typeof GROUPS)[number]['sections'][number]> extends never ? true : never = true;
void grouped;

function SectionLink({ s, current }: { s: Section; current: boolean }) {
  const { label, icon: Icon } = ITEMS[s];
  return (
    <a href={`#settings/${s}`} aria-current={current ? 'page' : undefined}
      className={cn('flex h-8 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
        current && 'border-foreground/20 bg-muted text-foreground')}>
      <Icon className="size-3.5" />{label}
    </a>
  );
}

function NavGroup({ g, section }: { g: Group; section: Section }) {
  const [open, toggle] = useGroupOpen(`settings.group.${g.id}`);
  const shown = open ? g.sections : g.sections.filter((s) => s === section);
  return (
    <div data-settings-group={g.id} className="flex min-w-0 flex-wrap items-center gap-1">
      <button type="button" data-slot="settings-group-toggle" aria-expanded={open} onClick={toggle}
        className="flex h-8 items-center gap-1 rounded px-1 text-[11px] font-semibold tracking-[0.08em] text-muted-foreground uppercase hover:bg-muted/40">
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}{g.label}
        {!open && <span className="num font-normal opacity-70">{g.sections.length}</span>}
      </button>
      {shown.map((s) => <SectionLink key={s} s={s} current={s === section} />)}
    </div>
  );
}

/** The jump list: every section by its group, the one open now picked. */
function Jump({ section }: { section: Section }) {
  return (
    <select data-slot="settings-jump" aria-label="Jump to a section" value={section} onChange={(e) => { window.location.hash = `#settings/${e.target.value}`; }}
      className="h-8 rounded-md border bg-background px-2 text-sm">
      {GROUPS.map((g) => <optgroup key={g.id} label={g.label}>{g.sections.map((s) => <option key={s} value={s}>{ITEMS[s].label}</option>)}</optgroup>)}
    </select>
  );
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
      <nav data-slot="settings-nav" aria-label="Settings sections" className="space-y-1">
        <Jump section={section} />
        {GROUPS.map((g) => <NavGroup key={g.id} g={g} section={section} />)}
      </nav>
      <Current />
    </div>
  );
}
