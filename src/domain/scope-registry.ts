// The scope registry (issue #909, design.md "Grants and refresh tokens" The scope registry): every scope a grant may
// hold, as a person picks it — grouped in sections by area of work, each with its plain description, the routes it
// covers, the least role they need and whether one is a box action —, and the presets, each a named set of scopes. Built
// from the routes themselves (./token-scopes.ts names their scopes), so a new route's scope shows up with no edit here: an
// area no section names goes under "Other". Pure: the HTTP layer gives the routes and what a box action is.
import { actionWord, scopeAllows, scopeOfAction, scopeOfRoute } from './token-scopes.ts';
import { DELEGATE_PRESET, DELEGATE_SCOPES } from './delegates.ts';
import { roleAllows, type ScopePermission, type ScopePreset, type ScopeRegistry, type ScopeSection, type UiRole } from './sign-in.ts';

export type { ScopePermission, ScopePreset, ScopeRegistry, ScopeSection };

/**
 * A route as the API reference lists it. `actions`: the field of its body that names what it does (`action`, `kind`)
 * and the actions it may name, when it names more than one (issue #909): each gets a scope of its own.
 */
export interface RegistryRoute { method: string; path: string; summary: string; role?: UiRole; actions?: { field: string; values: string[] } }

/** An action's plain words: `approve-template` → `Approve template`. */
const actionWords = (action: string): string => {
  const words = actionWord(action).replace(/-+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The sections, in order, and the route areas each holds. An area not named here goes under OTHER. */
export const SCOPE_SECTIONS: readonly { id: string; title: string; description: string; areas: readonly string[] }[] = [
  { id: 'jobs', title: 'Jobs', description: 'Jobs and the queue: read and search them, approve, cancel, run again, park and order them.', areas: ['jobs', 'delivery-forecast', 'delivery-settings', 'delivery-expedite', 'work-items', 'queue', 'queue-gate', 'pointed-jobs', 'preemption', 'priority-lanes', 'failures', 'backfill', 'tldr', 'search'] },
  { id: 'intake', title: 'Intake', description: 'Where jobs come from: the job sources, direct jobs, request cards, who is trusted, the GitHub connection, the GitLab account, and File an issue.', areas: ['sources', 'direct-jobs', 'direct-queries', 'intake-actors', 'intake-auto-approval', 'intake-decline', 'intake-strictness', 'connected-accounts', 'gitlab-account', 'repo-checks', 'issue-drafts'] },
  { id: 'questions', title: 'Questions and reviews', description: 'What jobs ask a person: questions, research, proposals, and the logins they wait on.', areas: ['questions', 'question-gates', 'auto-answer', 'thread-ask', 'phase-shifts', 'research', 'proposals', 'sections', 'logins'] },
  { id: 'pull-requests', title: 'Pull requests', description: 'The pull requests jobs open: merge, close, yolo mode, landing batches, contribution, the shrink guard, the default push requirements and GitHub watches.', areas: ['pull-requests', 'yolo-mode', 'landing-batches', 'contribution', 'shrink-guard', 'push-requirements', 'github-watches', 'github-rate-limiter'] },
  { id: 'infra', title: 'Infra changes', description: 'Plans of infrastructure changes, their approval, infra applies, out-of-band changes, the blast radius, the infrastructure topology and the GitHub deployment approvals that wait on you.', areas: ['infra-plans', 'infra-applies', 'out-of-band', 'blast-radius', 'topology', 'pending-approvals'] },
  { id: 'vault', title: 'Vault and credentials', description: 'The vault, its templates and credential requests, a job\'s vault grant, the cluster overrides, the sandbox runs jobs ask for, their approval toggles and the sandbox strictness, the bastions of jobs, Access and the master key.', areas: ['vault', 'clusters', 'sandbox-requests', 'sandbox-approvals', 'sandbox-strictness', 'bastions', 'access', 'master-key'] },
  { id: 'machines', title: 'Machines', description: 'Where jobs run: machines, the credential check, sandboxes, the sandbox playground, lanes, Windows hosts, Podman hosts and the Windows link.', areas: ['machines', 'credential-check', 'sandboxes', 'sandbox-playground', 'lanes', 'windows-hosts', 'podman-hosts', 'windows-link'] },
  { id: 'skills', title: 'Skills', description: 'The skill library: read it, create, edit, duplicate and remove a skill, and choose the skill each kind of work gets.', areas: ['skill-library', 'work-skills'] },
  { id: 'decider', title: 'Decider and rules', description: 'How the hopper decides: Jev\'s picks, the rules, the job rules, the repository job rules and the routing.', areas: ['minor-decisions', 'typesafe-key', 'rules', 'job-rules', 'repo-job-rules', 'routing', 'decisions', 'router'] },
  { id: 'state', title: 'State and usage', description: 'What the hopper is doing: health, events, usage and the token budget, accounts and the tool accounts, users, the instance, the resources of its stack, its own process and its telemetry summary.', areas: ['health', 'events', 'component-watchers', 'usage', 'usage-history', 'token-budget', 'header-badges', 'accounts', 'tool-accounts', 'instance', 'resources', 'process', 'telemetry', 'scopes'] },
  { id: 'sign-in', title: 'Sign-in and users', description: 'Who signs in and how: the realms, the local accounts, the source email match, the users, a login link for another device, and the end of a session.', areas: ['realms', 'local-accounts', 'source-email-match', 'users', 'device-link', 'logout'] },
  { id: 'settings', title: 'Settings', description: 'The hopper\'s own settings: plugins, notifiers, webhooks and the send log of what they sent, self-update, remote access, the GitHub webhook, the allowed hosts, telemetry, the cloud link to hopper.io, the instance\'s display name, the host link base, API tokens, artifacts and bug reports.', areas: ['plugins', 'plugin-store', 'notifiers', 'webhooks', 'outbound', 'update', 'remote-access', 'github-deliveries', 'allowed-hosts', 'telemetry-settings', 'cloud-link', 'display-name', 'host-link', 'api-tokens', 'artifacts', 'bug-reports'] },
];

/** Scopes shown in another section than their area's: a job's vault grant is a vault approval. */
const MOVED: Readonly<Record<string, string>> = { 'jobs:grant-vault': 'vault', 'jobs:revoke-vault': 'vault', 'jobs:deny-vault': 'vault' };

const OTHER = { id: 'other', title: 'Other', description: 'Routes no section names yet.' };

/** The presets. Each scope a preset names must be a route's, or a pattern that covers one (test/domain/scope-registry.test.ts). */
const PRESETS: readonly Omit<ScopePreset, 'box'>[] = [
  { id: 'read-only', label: 'Read only', description: 'Reads everything you can see — jobs, questions, intake, the Needs you list, settings — and changes nothing.', scopes: ['*:read'] },
  { id: 'agent-intake', label: 'Agent: read everything and approve intake', description: 'Reads everything, the Needs you list included, and acts on intake: approves request cards, assigns issues to you, releases claims, takes issues off the backburner. An approval starts a job, so it is a box grant.', scopes: ['*:read', 'sources:intake'] },
  { id: 'agent-approvals', label: 'Agent: read everything and approve what waits', description: 'Reads everything, and approves what waits for a person and is no infrastructure change: request cards in intake, held jobs, and a job\'s vault grant ask. A box grant. Infra plans and vault templates stay a person\'s: tick them below to add them.', scopes: ['*:read', 'sources:intake', 'jobs:approve', 'jobs:grant-vault'] },
  { id: DELEGATE_PRESET, label: 'Delegate approver', description: 'Approves on your behalf what waits for a person, and nothing else: a job\'s vault grant ask, a template, a sandbox request; it declines or denies them too. It reads the vault\'s view only. Its approver policy names what stays yours (e.g. prod). Each approval it makes names it and you. Mint it on Access requests.', scopes: [...DELEGATE_SCOPES] },
  { id: 'full-admin', label: 'Full admin', description: 'Everything your role allows, box actions included, and every route added later.', scopes: ['*'] },
];

const lower = (a: UiRole, b: UiRole): UiRole => (roleAllows(b, a) ? a : b);

/** The registry of the routes: one permission per scope, in its section; the presets with their box flag. */
export function scopeRegistry(routes: readonly RegistryRoute[], isBoxAction: (route: string) => boolean): ScopeRegistry {
  const byScope = new Map<string, ScopePermission & { summaries: Set<string> }>();
  const add = (scope: string, route: string, summary: string, role: UiRole, box: boolean, parent?: string): void => {
    const p = byScope.get(scope) ?? { scope, description: '', routes: [], role, ...(parent === undefined ? {} : { parent }), box: false, summaries: new Set<string>() };
    p.routes.push(route);
    p.summaries.add(summary);
    p.role = lower(p.role, role);
    p.box ||= box;
    byScope.set(scope, p);
  };
  for (const r of routes) {
    const method = r.method.toUpperCase();
    const scope = scopeOfRoute(method, r.path);
    if (scope === undefined) continue;
    const role = r.role ?? 'viewer';
    const box = method === 'POST' && isBoxAction(r.path);
    add(scope, `${method} ${r.path}`, r.summary, role, box);
    for (const a of r.actions?.values ?? []) add(scopeOfAction(scope, a), `${method} ${r.path} (${r.actions!.field}: ${a})`, `${actionWords(a)} (${r.summary})`, role, box, scope);
  }
  const all = [...byScope.values()].map(({ summaries, ...p }) => ({ ...p, description: [...summaries].join('; ') }));
  // Each route's scope, then its actions' under it.
  const permissions = all.filter((p) => p.parent === undefined).sort((a, b) => a.scope.localeCompare(b.scope))
    .flatMap((p) => [p, ...all.filter((q) => q.parent === p.scope).sort((a, b) => a.scope.localeCompare(b.scope))]);
  const sectionOf = (scope: string): string => {
    const route = byScope.get(scope)?.parent ?? scope;
    return MOVED[route] ?? SCOPE_SECTIONS.find((s) => s.areas.includes(route.split(':')[0]!))?.id ?? OTHER.id;
  };
  const sections = [...SCOPE_SECTIONS, OTHER]
    .map(({ id, title, description }) => ({ id, title, description, permissions: permissions.filter((p) => sectionOf(p.scope) === id) }))
    .filter((s) => s.permissions.length > 0);
  const presets = PRESETS.map((p) => ({ ...p, scopes: [...p.scopes], box: permissions.some((q) => q.box && scopeAllows(p.scopes, q.scope)) }));
  return { sections, presets };
}

/** The preset of that id, or undefined. */
export const presetOf = (registry: ScopeRegistry, id: string): ScopePreset | undefined => registry.presets.find((p) => p.id === id);

/** Every scope a route, or one of its actions, needs, sorted. */
export const scopesOf = (registry: ScopeRegistry): string[] => registry.sections.flatMap((s) => s.permissions.map((p) => p.scope)).sort();
