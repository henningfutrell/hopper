// How the vault rates a template (issue #584, issue #605): what the rating reads of it, with this user's blast-radius
// rules and the profiles access approved, and the view each template is shown and rated as.
import type { OperationProfile, TemplateApprovals } from '../domain/access.ts';
import { DEFAULT_BLAST_RADIUS_SETTINGS, type RadiusRules } from '../domain/blast-radius.ts';
import type { UserStore } from '../domain/ports.ts';
import { templateView, type Template, type TemplateView } from '../domain/vault.ts';
import { rateTemplate, type TemplateScope } from '../blast-radius/template.ts';

export interface TemplateRating {
  approvedOf(name: string): OperationProfile[];
  rules(): RadiusRules;
  /** What the rating reads of a template: its secrets' names and scope lines, never a value, and its profiles. */
  scopeOfTemplate(t: Template): TemplateScope;
  viewOf(t: Template): TemplateView;
}

export function templateRating(o: { store: Pick<UserStore, 'vault' | 'settings'>; access?: TemplateApprovals }): TemplateRating {
  const approvedOf = (name: string): OperationProfile[] => o.access?.approvedProfiles(name) ?? [];
  const rules = (): RadiusRules => (o.store.settings.getBlastRadius() ?? DEFAULT_BLAST_RADIUS_SETTINGS).rules;
  const scopeOfTemplate = (t: Template): TemplateScope => ({
    secrets: t.secrets.map((n) => { const s = o.store.vault.get(n); return { name: n, ...(s?.scope ? { scope: s.scope } : {}) }; }),
    profiles: t.profiles ?? [],
  });
  const viewOf = (t: Template): TemplateView => {
    const approved = approvedOf(t.name);
    return templateView(t, approved, rateTemplate(scopeOfTemplate(t), approved, rules()));
  };
  return { approvedOf, rules, scopeOfTemplate, viewOf };
}
