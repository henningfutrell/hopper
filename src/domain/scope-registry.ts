// The scope registry (issue #909, design.md "Grants and refresh tokens" The scope registry): every scope a grant may
// hold, as a person picks it — grouped in sections by area of work, each with its plain description, the routes it
// covers, the least role they need and whether one is a box action —, and the presets, each a named set of scopes. Built
// from the routes themselves (./token-scopes.ts names their scopes), so a new route's scope shows up with no edit here: an
// area no section names goes under "Other". Pure: the HTTP layer gives the routes and what a box action is.
import { scopeAllows, scopeOfRoute } from './token-scopes.ts';
import { roleAllows, type ScopePermission, type ScopePreset, type ScopeRegistry, type ScopeSection, type UiRole } from './sign-in.ts';

export type { ScopePermission, ScopePreset, ScopeRegistry, ScopeSection };

/** A route as the API reference lists it. */
export interface RegistryRoute { method: string; path: string; summary: string; role?: UiRole }

/** The sections, in order, and the route areas each holds. An area not named here goes under OTHER. */
export const SCOPE_SECTIONS: readonly { id: string; title: string; description: string; areas: readonly string[] }[] = [
  { id: 'jobs', title: 'Jobs', description: 'Jobs and the queue: read them, approve, cancel, run again, park and order them.', areas: ['jobs', 'queue', 'queue-gate', 'pointed-jobs', 'auto-park', 'priority-lanes', 'failures', 'backfill', 'tldr'] },
  { id: 'intake', title: 'Intake', description: 'Where jobs come from: the job sources, request cards, who is trusted, and the GitHub connection.', areas: ['sources', 'intake-actors', 'connected-accounts', 'repo-checks'] },
  { id: 'questions', title: 'Questions and reviews', description: 'What jobs ask a person: questions, research, proposals, and the logins they wait on.', areas: ['questions', 'question-gates', 'auto-answer', 'thread-ask', 'phase-shifts', 'research', 'proposals', 'sections', 'logins'] },
  { id: 'pull-requests', title: 'Pull requests', description: 'The pull requests jobs open: merge, close, yolo mode, contribution and GitHub watches.', areas: ['pull-requests', 'yolo-mode', 'contribution', 'github-watches', 'github-rate-limiter'] },
  { id: 'infra', title: 'Infra changes', description: 'Plans of infrastructure changes, their approval, out-of-band changes and the blast radius.', areas: ['infra-plans', 'out-of-band', 'blast-radius'] },
  { id: 'vault', title: 'Vault and credentials', description: 'The vault, its templates and credential requests, a job\'s vault grant, Access and the master key.', areas: ['vault', 'access', 'master-key'] },
  { id: 'machines', title: 'Machines', description: 'Where jobs run: machines, sandboxes, lanes and Windows hosts.', areas: ['machines', 'sandboxes', 'lanes', 'windows-hosts'] },
  { id: 'decider', title: 'Decider and rules', description: 'How the hopper decides: Jev\'s picks, the rules, the job rules and the routing.', areas: ['minor-decisions', 'typesafe-key', 'rules', 'job-rules', 'routing', 'decisions', 'router'] },
  { id: 'state', title: 'State and usage', description: 'What the hopper is doing: health, events, usage, accounts, users and the instance.', areas: ['health', 'events', 'usage', 'usage-history', 'accounts', 'instance', 'scopes'] },
  { id: 'sign-in', title: 'Sign-in and users', description: 'Who signs in and how: the realms, the users, a login link for another device, and the end of a session.', areas: ['realms', 'users', 'device-link', 'logout'] },
  { id: 'settings', title: 'Settings', description: 'The hopper\'s own settings: plugins, notifiers, webhooks, self-update, remote access, API tokens, artifacts and bug reports.', areas: ['plugins', 'plugin-store', 'notifiers', 'webhooks', 'update', 'remote-access', 'api-tokens', 'artifacts', 'bug-reports'] },
];

/** Scopes shown in another section than their area's: a job's vault grant is a vault approval. */
const MOVED: Readonly<Record<string, string>> = { 'jobs:grant-vault': 'vault', 'jobs:revoke-vault': 'vault' };

const OTHER = { id: 'other', title: 'Other', description: 'Routes no section names yet.' };

/** The presets. Each scope a preset names must be a route's, or a pattern that covers one (test/domain/scope-registry.test.ts). */
const PRESETS: readonly Omit<ScopePreset, 'box'>[] = [
  { id: 'read-only', label: 'Read only', description: 'Reads everything you can see — jobs, questions, intake, the Needs you list, settings — and changes nothing.', scopes: ['*:read'] },
  { id: 'agent-intake', label: 'Agent: read everything and approve intake', description: 'Reads everything, the Needs you list included, and acts on intake: approves request cards, assigns issues to you, releases claims, takes issues off the backburner. An approval starts a job, so it is a box grant.', scopes: ['*:read', 'sources:intake'] },
  { id: 'agent-approvals', label: 'Agent: read everything and approve what waits', description: 'Reads everything, and approves what waits for a person and is no infrastructure change: request cards in intake, held jobs, and a job\'s vault grant ask. A box grant. Infra plans and vault templates stay a person\'s: tick them below to add them.', scopes: ['*:read', 'sources:intake', 'jobs:approve', 'jobs:grant-vault'] },
  { id: 'full-admin', label: 'Full admin', description: 'Everything your role allows, box actions included, and every route added later.', scopes: ['*'] },
];

const lower = (a: UiRole, b: UiRole): UiRole => (roleAllows(b, a) ? a : b);

/** The registry of the routes: one permission per scope, in its section; the presets with their box flag. */
export function scopeRegistry(routes: readonly RegistryRoute[], isBoxAction: (route: string) => boolean): ScopeRegistry {
  const byScope = new Map<string, ScopePermission & { summaries: Set<string> }>();
  for (const r of routes) {
    const method = r.method.toUpperCase();
    const scope = scopeOfRoute(method, r.path);
    if (scope === undefined) continue;
    const role = r.role ?? 'viewer';
    const p = byScope.get(scope) ?? { scope, description: '', routes: [], role, box: false, summaries: new Set<string>() };
    p.routes.push(`${method} ${r.path}`);
    p.summaries.add(r.summary);
    p.role = lower(p.role, role);
    p.box ||= method === 'POST' && isBoxAction(r.path);
    byScope.set(scope, p);
  }
  const permissions = [...byScope.values()].sort((a, b) => a.scope.localeCompare(b.scope))
    .map(({ summaries, ...p }) => ({ ...p, description: [...summaries].join('; ') }));
  const sectionOf = (scope: string): string => MOVED[scope] ?? SCOPE_SECTIONS.find((s) => s.areas.includes(scope.split(':')[0]!))?.id ?? OTHER.id;
  const sections = [...SCOPE_SECTIONS, OTHER]
    .map(({ id, title, description }) => ({ id, title, description, permissions: permissions.filter((p) => sectionOf(p.scope) === id) }))
    .filter((s) => s.permissions.length > 0);
  const presets = PRESETS.map((p) => ({ ...p, scopes: [...p.scopes], box: permissions.some((q) => q.box && scopeAllows(p.scopes, q.scope)) }));
  return { sections, presets };
}

/** The preset of that id, or undefined. */
export const presetOf = (registry: ScopeRegistry, id: string): ScopePreset | undefined => registry.presets.find((p) => p.id === id);

/** Every scope a route needs, sorted. */
export const scopesOf = (registry: ScopeRegistry): string[] => registry.sections.flatMap((s) => s.permissions.map((p) => p.scope)).sort();
