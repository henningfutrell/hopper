// GitHub deliveries (issue #1079, design.md "GitHub deliveries"): GitHub's `issues` webhook, taken at POST /github/webhook,
// so a new or changed issue reaches intake in seconds, not after the intake sync interval. The hopper still pulls: a
// delivery changes no job, question, webhook or setting; it only makes the repository it names due at each user's sources
// whose job repository it is (`SourceRegistry.repoChanged`), which list it again at a sync a few seconds later, and records
// `source.delivery_received` in that user's log. The timed listing stays: a delivery that never comes costs only time.
// An issue closed or reopened that is a user's work item is also that event in the user's log (`work_item.issue_closed`,
// `work_item.issue_reopened`, issue #1067 part 3), which moves the item in the work-item ledger; when the ledger holds that
// state already, nothing is recorded.
//
// Signed: GitHub signs the body with the GitHub webhook secret (HMAC-SHA256, `X-Hub-Signature-256`), a system secret of the
// instance's vault the hopper's admin makes on Settings → GitHub webhook and pastes into GitHub; shown once. Without one,
// the route takes nothing (404). The check is node:crypto's HMAC and timingSafeEqual: a library for it would carry more
// than the few lines it replaces. A delivery GitHub sends again (its `X-GitHub-Delivery` id) is taken once.
//
// Most hoppers are not reachable from GitHub: a relay in front (`gh webhook forward`, smee) sends the deliveries on.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { DELIVERY_EVENTS, DELIVERY_PATH, deliveryTarget, type GitHubDeliveriesView } from '../domain/github-deliveries.ts';
import { issueChangeEvent } from '../domain/work-items.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import type { Clock } from '../domain/ports.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { HttpError } from './errors.ts';
import type { Tenants } from './tenants.ts';

/** The GitHub webhook secret: a system secret of the instance's vault. */
export const DELIVERY_SECRET: SystemSecretName = 'github-webhook-secret';

/** How many delivery ids are kept to take a redelivery once. */
const KEPT_IDS = 500;

/** The largest body taken: GitHub caps a payload at 25 MB, an `issues` one is far smaller. */
const BODY_LIMIT = 5 * 1024 * 1024;

type Answer = { status: 200 | 202 | 400 | 401 | 404 | 415 | 503; body: Record<string, unknown> };

export interface GitHubDeliveries {
  view(): GitHubDeliveriesView;
  /** `make`: a new secret, answered once (a second make rotates it); `remove`: none, so nothing is taken. Throws HttpError 503 without a master key. */
  change(action: 'make' | 'remove', by: string): GitHubDeliveriesView & { generatedSecret?: string };
  /** One delivery: its headers and its body as sent. */
  receive(headers: Record<string, string | string[] | undefined>, body: Buffer): Answer;
}

const header = (h: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = h[name];
  return Array.isArray(v) ? v[0] : v;
};

/** Whether `signature` (`sha256=<hex>`) is the body's HMAC-SHA256 under `secret`. */
export function signatureHolds(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (signature === undefined || !signature.startsWith('sha256=')) return false;
  const want = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const got = Buffer.from(signature);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function createGitHubDeliveries(o: {
  secrets: Pick<SystemSecrets, 'open' | 'meta' | 'keep' | 'drop' | 'problem'>;
  tenants: Pick<Tenants, 'list' | 'user'>;
  clock: Clock;
}): GitHubDeliveries {
  const seen = new Set<string>();
  const counts = { received: 0, refused: 0, ignored: 0 };
  let last: GitHubDeliveriesView['last'];
  let lastRefused: GitHubDeliveriesView['lastRefused'];
  const now = () => o.clock.now().toISOString();

  const refuse = (status: 401 | 503, why: string): Answer => {
    counts.refused += 1;
    lastRefused = { at: now(), why };
    return { status, body: { error: why } };
  };

  const view = (): GitHubDeliveriesView => {
    const meta = o.secrets.meta(DELIVERY_SECRET);
    const problem = o.secrets.problem();
    return {
      path: DELIVERY_PATH, events: [...DELIVERY_EVENTS],
      secret: meta ? { set: true, setBy: meta.setBy, setAt: meta.setAt, ...(meta.last4 ? { last4: meta.last4 } : {}) } : { set: false },
      ...(problem ? { problem } : {}), ...counts, ...(last ? { last } : {}), ...(lastRefused ? { lastRefused } : {}),
    };
  };

  /** The once-only check: false when this delivery id was taken before. */
  const first = (id: string | undefined): boolean => {
    if (id === undefined) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    if (seen.size > KEPT_IDS) seen.delete(seen.values().next().value!);
    return true;
  };

  return {
    view,
    change(action, by) {
      if (action === 'remove') {
        o.secrets.drop(DELIVERY_SECRET, by);
        return view();
      }
      const problem = o.secrets.problem();
      if (problem) throw new HttpError(503, problem);
      const value = randomBytes(32).toString('hex');
      const r = o.secrets.keep(DELIVERY_SECRET, value, by, { rotated: true });
      if (!r.ok) throw new HttpError(503, r.error);
      return { ...view(), generatedSecret: value };
    },
    receive(headers, body) {
      let secret: string | undefined;
      try {
        secret = o.secrets.open(DELIVERY_SECRET, 'a GitHub delivery');
      } catch (e) {
        if (e instanceof SecretUnreadable) return refuse(503, 'the GitHub webhook secret cannot be opened');
        throw e;
      }
      if (secret === undefined) return { status: 404, body: { error: 'no GitHub webhook secret is set: Settings → GitHub webhook' } };
      const signature = header(headers, 'x-hub-signature-256');
      if (signature === undefined) return refuse(401, 'no signature');
      if (!signatureHolds(secret, body, signature)) return refuse(401, 'the signature does not hold');
      const event = header(headers, 'x-github-event') ?? '';
      const delivery = header(headers, 'x-github-delivery');
      if (!first(delivery)) return { status: 200, body: { taken: 'before' } };
      let payload: unknown;
      try {
        payload = JSON.parse(body.toString('utf8'));
      } catch {
        return { status: 400, body: { error: 'the body is no JSON' } };
      }
      const target = deliveryTarget(event, payload);
      if (!target) {
        counts.ignored += 1;
        return { status: event === 'ping' ? 200 : 202, body: {} };
      }
      counts.received += 1;
      last = { at: now(), delivery: delivery ?? '', event, action: target.action, repo: target.repo };
      for (const user of o.tenants.list()) {
        const parts = o.tenants.user(user.id);
        if (!parts) continue;
        const item = target.issue && parts.store.workItems.get(target.issue.url);
        const moved = item && issueChangeEvent(item, { state: target.action === 'closed' ? 'closed' : 'open', ...(target.issue?.reason ? { reason: target.issue.reason } : {}) }, 'delivery');
        if (moved) parts.store.events.append(moved);
        const sources = parts.registry.repoChanged(target.repo);
        if (sources.length === 0) continue;
        parts.store.events.append({
          type: 'source.delivery_received',
          data: { sources, delivery: delivery ?? '', event, action: target.action, repo: target.repo, ...(target.number === undefined ? {} : { number: target.number }) },
        });
      }
      return { status: 202, body: {} };
    },
  };
}

/**
 * POST /github/webhook: a GitHub delivery, its body read as sent, for the signature. Off /api/: no session, the signature is
 * its check. It changes no job, question, webhook or setting.
 */
export function githubDeliveryRoutes(app: FastifyInstance, o: { deliveries: Pick<GitHubDeliveries, 'receive'> }): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, body, done) => { done(null, body); });
    scope.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT }, (_req, _body, done) => {
      done(new HttpError(415, 'a GitHub delivery is taken as JSON only: set the webhook\'s content type to application/json'), undefined);
    });
    scope.post(DELIVERY_PATH, async (req, reply) => {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const r = o.deliveries.receive(req.headers, body);
      return reply.code(r.status).header('cache-control', 'no-store').send(r.body);
    });
  });
}
