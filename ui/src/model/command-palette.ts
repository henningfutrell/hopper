// The command palette (issue #2661, design.md "The command palette"), pure: what it can find and where each entry goes.
// Its commands come from the scope registry (GET /api/scopes, src/domain/scope-registry.ts): every route that changes
// something is a command, with the route's own summary as its words, shown only when the person's role is at least the
// route's least role. So a new route is a new command with no edit here. A command on one job (`/ui/api/jobs/:id/<act>`)
// is an action of a job the palette shows; a command on no one item opens the page where it is done. The pages are the
// routes' (routes.ts), the settings the Settings view's sections; the vault is found by names only, never a value.
import type { Job, ScopeRegistry, SuggestAnswer, UiRole, VaultView } from './wire.ts';

/** The kinds of entry, in the order the palette shows their groups. */
export const PALETTE_GROUPS = ['Recent', 'Pages', 'Commands', 'Jobs', 'Issues', 'Pull requests', 'Artifacts', 'Infra plans', 'Questions', 'Machines', 'Vault', 'Settings'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** One thing the palette finds. `href`: where it goes; `job`: a job, which has actions of its own. */
export interface PaletteEntry { id: string; group: PaletteGroup; label: string; hint?: string; keywords?: string[]; href: string; job?: string }

const ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];
/** Whether a role may do what needs `needs` (as the daemon's roleAllows). */
export const roleAllows = (role: UiRole, needs: UiRole): boolean => ROLES.indexOf(role) >= ROLES.indexOf(needs);

/** Where each scope section's commands are done, when its area has no page of its own. */
const SECTION_HASH: Readonly<Record<string, string>> = {
  jobs: '#jobs', intake: '#intake', questions: '#questions', 'pull-requests': '#pull-requests', infra: '#infra', vault: '#vault',
  machines: '#machines', skills: '#skills', decider: '#settings/decider', state: '#dashboard', 'sign-in': '#users-access', settings: '#settings',
};

/** The route areas whose commands are done on a page or settings section of another name. */
const AREA_HASH: Readonly<Record<string, string>> = {
  queue: '#jobs/queue', 'queue-gate': '#jobs/queue', failures: '#failures', research: '#research', proposals: '#proposals',
  logins: '#machines/logins', accounts: '#machines/accounts', 'tool-accounts': '#machines/accounts', 'direct-jobs': '#ask',
  'direct-queries': '#ask/direct-queries', artifacts: '#artifacts', events: '#activity', decisions: '#activity/decisions',
  usage: '#usage', resources: '#usage/resources', topology: '#topology', 'pending-approvals': '#approvals/pending-approvals',
  'sandbox-requests': '#approvals/access-requests', plugins: '#plugins', 'plugin-store': '#plugins', 'skill-library': '#skills',
  'work-skills': '#skills', 'local-accounts': '#users-access', users: '#users-access', realms: '#settings/sign-in',
  'minor-decisions': '#settings/decider', 'intake-actors': '#settings/intake', 'delivery-settings': '#settings/delivery',
  'github-deliveries': '#settings/github-webhook', 'github-rate-limiter': '#settings/github-rate-limit',
  'telemetry-settings': '#settings/telemetry', 'display-name': '#settings/version', update: '#settings/version',
  'bug-reports': '#reports', sources: '#sources', 'pull-requests': '#pull-requests', 'infra-plans': '#infra',
};

/** A scope's route area: `jobs:cancel` → `jobs`. */
const areaOf = (scope: string): string => scope.split(':')[0]!;

/** The page a command on no one item is done on: its area's page, a settings section of the area's name, else its section's page. */
export function commandHref(scope: string, section: string, settingsSections: readonly string[]): string {
  const area = areaOf(scope);
  return AREA_HASH[area] ?? (settingsSections.includes(area) ? `#settings/${area}` : SECTION_HASH[section] ?? '#dashboard');
}

/** A job's own route: `POST /ui/api/jobs/:id/<act>`; its act, else undefined. */
const jobActOf = (route: string): string | undefined => /^POST \/ui\/api\/jobs\/:id\/([a-z-]+)$/.exec(route)?.[1];

/** One action on a job: its act (the route's last part) and its words. */
export interface JobAction { act: string; label: string; scope: string }

/** The permissions of the registry that change something and the role allows; an action of a route's body is its route's. */
function allowed(registry: ScopeRegistry, role: UiRole) {
  return registry.sections.flatMap((s) => s.permissions
    .filter((p) => p.parent === undefined && p.routes.some((r) => r.startsWith('POST ')) && roleAllows(role, p.role))
    .map((p) => ({ ...p, section: s.id })));
}

/** The actions on one job the role allows, from the registry. */
export function jobActions(registry: ScopeRegistry, role: UiRole): JobAction[] {
  return allowed(registry, role).flatMap((p) => p.routes.map(jobActOf).filter((a): a is string => a !== undefined)
    .map((act) => ({ act, label: p.description.split('; ')[0]!, scope: p.scope })));
}

/** The commands on no one job the role allows, from the registry: each opens the page where it is done. */
export function commandEntries(registry: ScopeRegistry, role: UiRole, settingsSections: readonly string[]): PaletteEntry[] {
  return allowed(registry, role).filter((p) => !p.routes.every((r) => jobActOf(r) !== undefined))
    .map((p) => ({ id: `command:${p.scope}`, group: 'Commands' as const, label: p.description, hint: p.scope, keywords: [p.scope, areaOf(p.scope)], href: commandHref(p.scope, p.section, settingsSections) }));
}

/** The pages: every route a person opens by name, and each tab of a merged page. */
export function pageEntries(pages: readonly { hash: string; label: string; under?: string }[]): PaletteEntry[] {
  return pages.map((p) => ({ id: `page:${p.hash}`, group: 'Pages' as const, label: p.under ? `${p.under}: ${p.label}` : p.label, href: p.hash }));
}

/** The Settings view's sections. */
export const settingsEntries = (sections: readonly { id: string; label: string }[]): PaletteEntry[] =>
  sections.map((s) => ({ id: `settings:${s.id}`, group: 'Settings' as const, label: s.label, hint: 'Settings', keywords: ['settings', s.id], href: `#settings/${s.id}` }));

/** The vault's entries by name: its secrets, shared secrets, system secrets and templates. Only names are read, never a value. */
export function vaultEntries(view: VaultView | null): PaletteEntry[] {
  if (!view) return [];
  const names: { kind: string; name: string }[] = [
    ...view.secrets.map((s) => ({ kind: 'secret', name: s.name })),
    ...(view.shared ?? []).map((s) => ({ kind: 'shared secret', name: s.name })),
    ...(view.system?.secrets ?? []).map((s) => ({ kind: 'system secret', name: s.name })),
    ...view.templates.map((t) => ({ kind: 'template', name: t.name })),
  ];
  return names.map(({ kind, name }) => ({ id: `vault:${kind}:${name}`, group: 'Vault' as const, label: name, hint: kind, href: '#vault' }));
}

/** A job's words: its item's title, else its goal, else its id. */
export const jobLabel = (j: Job): string => j.source?.title || j.spec.goal || j.id;

/** The jobs the page holds now. */
export const jobEntries = (jobs: readonly Job[]): PaletteEntry[] =>
  jobs.map((j) => ({ id: `job:${j.id}`, group: 'Jobs' as const, label: jobLabel(j), hint: j.status, keywords: [j.id, j.source?.repo ?? ''], href: `#job/${encodeURIComponent(j.id)}`, job: j.id }));

const SUGGESTION_GROUP: Readonly<Record<string, PaletteGroup>> = { job: 'Jobs', issue: 'Issues', 'pull-request': 'Pull requests', artifact: 'Artifacts', 'infra-plan': 'Infra plans' };

/**
 * The search index's suggestions (GET /api/search/suggest: the hopper's own copy, never GitHub), as entries; a job the
 * page already holds is not named twice. `href` is the hit's own link (model/search.ts hitHref); only a job has actions.
 */
export function suggestionEntries(suggestions: SuggestAnswer['suggestions'], held: ReadonlySet<string>, hrefOf: (s: SuggestAnswer['suggestions'][number]) => string): PaletteEntry[] {
  return suggestions.filter((s) => !(s.type === 'job' && held.has(`job:${s.ref}`)))
    .map((s) => ({ id: `${s.type}:${s.ref}`, group: SUGGESTION_GROUP[s.type] ?? 'Jobs', label: s.title, href: hrefOf(s), ...(s.type === 'job' ? { job: s.ref } : {}) }));
}

/** At most this many recent entries are kept. */
export const RECENT_MAX = 8;

/** The recent entries with this one first, each once, at most RECENT_MAX. */
export function withRecent(recent: readonly PaletteEntry[], e: PaletteEntry): PaletteEntry[] {
  const { id, label, href, hint, job } = e;
  const kept: PaletteEntry = { id, group: 'Recent', label, href, ...(hint ? { hint } : {}), ...(job ? { job } : {}) };
  return [kept, ...recent.filter((r) => r.id !== id)].slice(0, RECENT_MAX);
}

/** Recent entries read back from storage: anything not an entry is dropped. */
export function parseRecent(raw: string | null): PaletteEntry[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((e): e is PaletteEntry => typeof e?.id === 'string' && typeof e.label === 'string' && typeof e.href === 'string').map((e) => ({ ...e, group: 'Recent' as const })).slice(0, RECENT_MAX) : [];
  } catch { return []; }
}
