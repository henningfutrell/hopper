// The vault (issue #558, design.md "The vault"): the read — its secrets' metadata, never a value, not cached. Changes
// are the UI session's (src/http/ui/vault.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { profileRef } from '../domain/confirmation-asks.ts';
import { liveWrites, rememberHoursOf } from '../domain/remembered-writes.ts';
import { looseAsks, runCards } from '../domain/run-cards.ts';
import { autoApproveOf, NO_SKIPS, type SandboxApprovals } from '../domain/sandbox-approvals.ts';
import { knownClusters, shortClusters, unknownAssets, type ClusterFacts } from '../domain/unknown-assets.ts';
import type { ProfileAsk, VaultView } from '../domain/vault.ts';
import { BOX_IMAGE, pulledImage } from '../sandbox/box-image.ts';
import { createImageCheck } from '../sandbox/image-published.ts';
import type { TemplateRequestUser } from '../skills/template-request.ts';
import type { TenantParts } from './tenants.ts';
import { shownAsks } from './ui/confirmation-asks.ts';
import { readClusters } from '../vault/clusters.ts';
import { vaultView } from '../vault/vault.ts';
import { actionAsks, grantsNow } from '../vault/action-grants.ts';
import { LIVE } from '../users/sandbox-requests.ts';

/**
 * The needs' assets the vault cannot find (issue #2067): from the vault's minting credentials, the user's cluster
 * overrides, and the clusters the topology's AWS sources list, read now.
 */
const clusterFacts = (parts: Pick<TenantParts, 'vault' | 'store'>): ClusterFacts =>
  ({ secrets: parts.vault.view().secrets, overrides: readClusters(parts.store.config), known: knownClusters(parts.store.topology.list()) });

/**
 * What `GET /api/vault` and each vault edit answer: the vault's view, the user's read policy (issue #716), the
 * waiting profiles an API token asked to approve (issue #909), the sandbox approvals and requests (issue #991), the
 * run cards (issue #2197), and the asks and grants of AWS actions (issue #2206).
 */
export async function vaultAnswer(parts: Pick<TenantParts, 'vault' | 'store'> & Partial<Pick<TenantParts, 'sandboxRequests' | 'bastions'>>): Promise<VaultView> {
  const view = await vaultView(parts.vault);
  const facts = clusterFacts(parts);
  // Issue #1001: the job that asked for each template, by its title and its issue or pull request. Issue #2067: the
  // assets of its needs the vault cannot find. Issue #2168: its short cluster names, each with the cluster it resolves to.
  const templates = view.templates.map((t) => {
    const job = t.askedBy ? parts.store.jobs.get(t.askedBy) : undefined;
    const u = unknownAssets(t.profiles, facts), short = shortClusters(t.profiles, facts);
    const shown = { ...t, ...(u.length ? { unknownAssets: u } : {}), ...(short.length ? { shortClusters: short } : {}) };
    if (!t.askedBy || !job) return shown;
    const title = job.source?.title ?? job.spec.goal, url = job.source?.url;
    return { ...shown, askedByJob: { id: t.askedBy, ...(title ? { title } : {}), ...(url ? { url } : {}) } };
  });
  const asked = shownAsks(parts.store, 'vault-profile');
  const asks = view.templates.flatMap((t) => t.pending.profiles.flatMap((p): ProfileAsk[] => {
    const a = asked.get(profileRef(t.name, p));
    return a ? [{ template: t.name, ...p, ...a }] : [];
  }));
  const requests = parts.sandboxRequests?.list() ?? [];
  const actions = actionAsks(parts.store, new Date());
  const runs = runCards({ templates, requests, waits: parts.sandboxRequests?.waits() ?? [], job: (id) => cardJob(parts.store, id), actionAsks: actions });
  return {
    ...view, templates, readPolicy: parts.store.settings.getReadPolicy()?.assets ?? [], ...(asks.length ? { asks } : {}),
    // Sandboxes jobs start (issue #991): the toggles, and the requests of jobs at work.
    // The auto-approve policy (issue #1001) answered in full, the default where none was set.
    sandboxApprovals: approvalsInFull(parts.store.settings.getSandboxApprovals() ?? NO_SKIPS), sandboxRequests: requests, runs,
    // Issue #2146: the bastions that run now, for a person to stop.
    ...(parts.bastions ? { bastions: parts.bastions.list() } : {}),
    rememberedWrites: rememberedNow(parts.store),
    // Issue #2206: the asks for an AWS action that wait for a person and no run card holds, and the grants live now.
    actionAsks: looseAsks(actions, runs), actionGrants: grantsNow(parts.store, new Date()),
  };
}

/** A run card's job (issue #2197): its title and its issue or pull request; undefined once it ended. */
function cardJob(store: TenantParts['store'], id: string): { title?: string; url?: string } | undefined {
  const job = store.jobs.get(id);
  if (!job || !LIVE.includes(job.status)) return undefined;
  const title = job.source?.title ?? job.spec.goal, url = job.source?.url;
  return { ...(title ? { title } : {}), ...(url ? { url } : {}) };
}

/** The time limit for remembered write approvals (issue #1001) answered too, the default where none was set. */
const approvalsInFull = (a: SandboxApprovals): SandboxApprovals => ({ ...a, autoApprove: autoApproveOf(a), rememberWritesHours: rememberHoursOf(a) });

/** A person's write approvals the hopper remembers now (issue #1001), each with its end. */
const rememberedNow = (store: TenantParts['store']) => liveWrites(store.settings.getRememberedWrites(), rememberHoursOf(store.settings.getSandboxApprovals()), new Date());

/**
 * Whether the image a template's box pulls is published (issue #1977): the test image of the hopper's own branch (issue
 * #1976). One check for every user, so its answers are kept once.
 */
const published = createImageCheck();
const publishedImage = (image: string): Promise<string | undefined> => published(pulledImage(image));

/**
 * The user's side of a template request (issue #716): their templates, through the vault's own save and approve, their
 * read policy deciding. A job's (`POST /job/skill`) and an API caller's (`request-template`, issue #718) are the same.
 */
export function templateRequestUser(parts: Pick<TenantParts, 'vault' | 'store'>): TemplateRequestUser {
  return {
    template: (name) => parts.vault.view().templates.find((t) => t.name === name),
    templates: () => parts.vault.view().templates,
    save: (t, by) => parts.vault.saveTemplate(t, by),
    approve: (name, by) => parts.vault.approveTemplate(name, by),
    approveProfile: (name, profile, by) => parts.vault.approveProfile(name, profile, by),
    policy: () => parts.store.settings.getReadPolicy(),
    approvals: () => parts.store.settings.getSandboxApprovals(),
    remembered: () => rememberedNow(parts.store),
    imageProblem: publishedImage,
    unknownAssets: (needs) => unknownAssets(needs, clusterFacts(parts)),
    image: `${BOX_IMAGE}:box-claude`,
  };
}

export function vaultRoutes(app: FastifyInstance, o: { tenant: (req: FastifyRequest) => TenantParts }): void {
  app.get('/api/vault', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return await vaultAnswer(o.tenant(req));
  });
}
