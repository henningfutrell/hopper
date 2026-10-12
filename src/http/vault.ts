// The vault (issue #558, design.md "The vault"): the read — its secrets' metadata, never a value, not cached. Changes
// are the UI session's (src/http/ui/vault.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { profileRef } from '../domain/confirmation-asks.ts';
import type { ProfileAsk, VaultView } from '../domain/vault.ts';
import { BOX_IMAGE } from '../sandbox/launch.ts';
import type { TemplateRequestUser } from '../skills/template-request.ts';
import type { TenantParts } from './tenants.ts';
import { shownAsks } from './ui/confirmation-asks.ts';
import { BOX_AGENTS } from './ui/machine-join.ts';
import { vaultView } from '../vault/vault.ts';

/**
 * What `GET /api/vault` and each vault edit answer: the vault's view, the user's read policy (issue #716), and the
 * waiting profiles an API token asked to approve (issue #909).
 */
export async function vaultAnswer(parts: Pick<TenantParts, 'vault' | 'store'>): Promise<VaultView> {
  const view = await vaultView(parts.vault);
  const asked = shownAsks(parts.store, 'vault-profile');
  const asks = view.templates.flatMap((t) => t.pending.profiles.flatMap((p): ProfileAsk[] => {
    const a = asked.get(profileRef(t.name, p));
    return a ? [{ template: t.name, ...p, ...a }] : [];
  }));
  return { ...view, readPolicy: parts.store.settings.getReadPolicy()?.assets ?? [], ...(asks.length ? { asks } : {}) };
}

/**
 * The user's side of a template request (issue #716): their templates, through the vault's own save and approve, their
 * read policy deciding. A job's (`POST /job/skill`) and an API caller's (`request-template`, issue #718) are the same.
 */
export function templateRequestUser(parts: Pick<TenantParts, 'vault' | 'store'>): TemplateRequestUser {
  return {
    template: (name) => parts.vault.view().templates.find((t) => t.name === name),
    save: (t, by) => parts.vault.saveTemplate(t, by),
    approve: (name, by) => parts.vault.approveTemplate(name, by),
    policy: () => parts.store.settings.getReadPolicy(),
    image: `${BOX_IMAGE}:box-${BOX_AGENTS[0]}`,
  };
}

export function vaultRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/vault', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return await vaultAnswer(o.tenant(req));
  });
}
