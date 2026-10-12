// The scopes of a grant as a person picks them (issue #909): the presets, each one click that ticks its boxes and says in
// plain words what it can do, then every scope of the registry (GET /api/scopes) as a box, in sections by area of work,
// always open — so the form is also a map of all the hopper can do. Each box shows what it lets an agent do, the routes
// it covers, the least role they need, and whether it is a box action. A route that does one of several actions has a box
// for each action under its own: the route's box ticks them all, an action's box only that one. Nothing is typed.
import { Label } from '@/components/vault-fields';
import { Button } from '@/components/ui/button';
import { boxPermissions, permissionsOf, presetOfScopes, scopeTicked, toggleScope } from '@/model/api-tokens';
import type { ScopeRegistry, UiRole } from '@/model/wire';

const ROLES: readonly UiRole[] = ['viewer', 'operator', 'admin'];

export function ScopeChecklist({ registry, scopes, onChange, role, disabled }: {
  registry: ScopeRegistry; scopes: string[]; onChange: (scopes: string[]) => void;
  /** The grant's role: a scope that needs more is marked, as its tokens get 403 there. */
  role: UiRole; disabled: boolean;
}) {
  const known = permissionsOf(registry).map((p) => p.scope);
  const preset = presetOfScopes(scopes, registry);
  const box = boxPermissions(scopes, registry);
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <Label>Presets — one click ticks their boxes below; change them as you like</Label>
        <ul className="grid gap-2 sm:grid-cols-2">
          {registry.presets.map((p) => (
            <li key={p.id} className={`rounded-md border p-2 ${preset === p.id ? 'border-primary' : ''}`}>
              <Button type="button" size="sm" variant={preset === p.id ? 'default' : 'outline'} disabled={disabled} onClick={() => onChange([...p.scopes])}>{p.label}</Button>
              <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="grant-scopes">Scopes it holds: {scopes.length ? <code>{scopes.join(' ')}</code> : 'none — tick at least one'}</p>
      {box.length > 0 && (
        <p className="rounded-md border border-warn p-2 text-xs">A box grant: {box.length} ticked {box.length === 1 ? 'scope is a box action' : 'scopes are box actions'} — {box.map((p) => p.scope).join(', ')} —: they start jobs, run commands, approve or merge, update, or change the work on a machine. Access decides each one too.</p>
      )}
      {registry.sections.map((s) => (
        <fieldset key={s.id} className="space-y-1 rounded-md border p-3" disabled={disabled}>
          <legend className="px-1 text-sm font-medium">{s.title}</legend>
          <p className="text-xs text-muted-foreground">{s.description}</p>
          <ul className="space-y-1">
            {s.permissions.map((p) => (
              <li key={p.scope} className={p.parent !== undefined ? 'ml-6' : undefined}>
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-1" name={`scope-${p.scope}`} checked={scopeTicked(scopes, p.scope)}
                    onChange={(e) => onChange(toggleScope(scopes, p.scope, e.target.checked, known))} />
                  <span className="space-y-0.5">
                    <span className="block">{p.description}{' '}
                      <code className="text-xs text-muted-foreground">{p.scope}</code>
                      {p.box && <span className="ml-1 rounded border px-1 text-xs">box action</span>}
                      {ROLES.indexOf(p.role) > ROLES.indexOf(role) && <span className="ml-1 rounded border border-warn px-1 text-xs">needs {p.role}</span>}
                    </span>
                    <span className="block font-mono text-xs break-all text-muted-foreground">{p.routes.join(' · ')}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}
