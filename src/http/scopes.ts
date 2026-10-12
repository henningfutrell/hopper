// The scope registry of this daemon's routes (issue #909, src/domain/scope-registry.ts): from the API reference's
// operations, which name each route's summary and least role, and the box actions. What `GET /api/scopes` answers and a
// grant's mint checks its scopes and preset against.
import { scopeRegistry, type RegistryRoute, type ScopeRegistry } from '../domain/scope-registry.ts';
import { OPERATIONS } from './openapi.ts';
import { isBoxAction } from './ui/box-actions.ts';

/** Every route of the API reference, as the registry reads it. */
export const registryRoutes = (): RegistryRoute[] =>
  OPERATIONS.map((op) => ({ method: op.method, path: op.path, summary: op.summary, ...(op.role ? { role: op.role } : {}) }));

/** The registry of this daemon's routes. */
export const routeScopeRegistry = (): ScopeRegistry => scopeRegistry(registryRoutes(), isBoxAction);

