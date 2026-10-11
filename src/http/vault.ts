// The vault (issue #558, design.md "The vault"): the read — its secrets' metadata, never a value, not cached. Changes
// are the UI session's (src/http/ui/vault.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { VaultView } from '../domain/vault.ts';
import type { TenantParts } from './tenants.ts';
import { vaultView } from '../vault/vault.ts';

/** What `GET /api/vault` and each vault edit answer: the vault's view, and the user's read policy (issue #716). */
export async function vaultAnswer(parts: Pick<TenantParts, 'vault' | 'store'>): Promise<VaultView> {
  return { ...await vaultView(parts.vault), readPolicy: parts.store.settings.getReadPolicy()?.assets ?? [] };
}

export function vaultRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/vault', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return await vaultAnswer(o.tenant(req));
  });
}
