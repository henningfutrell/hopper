// The scope registry of this daemon's routes (issue #909, src/domain/scope-registry.ts): from the API reference's
// operations, which name each route's summary, least role and body, and the box actions. What `GET /api/scopes` answers
// and a grant's mint checks its scopes and preset against. A body that names one of several actions — a discriminated
// union, or an object whose `action` or `kind` is one of a set — gives each action a scope of its own.
import { scopeRegistry, type RegistryRoute, type ScopeRegistry } from '../domain/scope-registry.ts';
import { OPERATIONS } from './openapi.ts';
import { isBoxAction } from './ui/box-actions.ts';

/** Zod's own fields this reads, as they are in zod 4. */
interface Schema { def?: { type?: string; discriminator?: string; values?: unknown[]; entries?: Record<string, unknown> }; options?: Schema[]; shape?: Record<string, Schema> }

const literals = (s: Schema | undefined): string[] => {
  const d = s?.def;
  if (d?.type === 'literal') return (d.values ?? []).filter((v): v is string => typeof v === 'string');
  if (d?.type === 'enum') return Object.values(d.entries ?? {}).filter((v): v is string => typeof v === 'string');
  return [];
};

/** The field of the body that names what the route does, and its actions; undefined when it names fewer than two. */
export function bodyActions(body: unknown): { field: string; values: string[] } | undefined {
  const s = body as Schema | undefined;
  const found = s?.def?.discriminator !== undefined
    ? { field: s.def.discriminator, values: (s.options ?? []).flatMap((o) => literals(o.shape?.[s.def!.discriminator!])) }
    : ['action', 'kind'].map((field) => ({ field, values: literals(s?.shape?.[field]) })).find((a) => a.values.length > 0);
  if (!found) return undefined;
  const values = [...new Set(found.values)].sort();
  return values.length > 1 ? { field: found.field, values } : undefined;
}

/** Every route of the API reference, as the registry reads it. */
export const registryRoutes = (): RegistryRoute[] =>
  OPERATIONS.map((op) => {
    const actions = op.method === 'post' ? bodyActions(op.body) : undefined;
    return { method: op.method, path: op.path, summary: op.summary, ...(op.role ? { role: op.role } : {}), ...(actions ? { actions } : {}) };
  });

/** The field that names a POST route's action (`/ui/api/vault` → `action`), by the route as Fastify registers it; undefined: none. */
export function actionFields(): (route: string) => string | undefined {
  const fields = new Map(registryRoutes().flatMap((r) => (r.actions ? [[r.path, r.actions.field] as const] : [])));
  return (route) => fields.get(route);
}

/** The registry of this daemon's routes. */
export const routeScopeRegistry = (): ScopeRegistry => scopeRegistry(registryRoutes(), isBoxAction);
