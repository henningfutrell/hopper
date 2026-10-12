// Remote access (issue #880, design.md "Remote access"): the tunnel is set in the UI, never in a file on the host. The
// hopper's admin turns it on or off and sets the domain reserved at ngrok (the instance's settings, `remoteAccess`) and
// the ngrok authtoken (a system secret of the instance's vault, `remote-access.ngrok-authtoken`), at
// POST /ui/api/remote-access. The compose service `tunnel` holds nothing: it asks the hopper for them every few seconds at
// GET /tunnel/agent, with the preshared key both read from a file in memory (HOPPER_TUNNEL_KEY, made at each start of the
// stack), starts ngrok with them, and starts it again when they change. Its ask reports what ngrok did (running, or the
// code of the error it stopped with), which the status shows with the tunnel watch's word on whether the URL is up.
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import {
  AGENT_REPORT, AUTHTOKEN, domainOf, ngrokErrorText, tunnelUrlOf,
  type RemoteAccessChange, type RemoteAccessSettings, type RemoteAccessStatus, type RemoteAccessView,
} from '../domain/remote-access.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { HttpError } from './errors.ts';
import { watchTunnel, type TunnelWatch } from './tunnel.ts';

export const AUTHTOKEN_SECRET = 'remote-access.ngrok-authtoken';

/** The tunnel service's preshared key: the variable, or the file `HOPPER_TUNNEL_KEY_FILE` names (the stack's, in memory). */
export const TUNNEL_KEY_VARIABLE = 'HOPPER_TUNNEL_KEY';

/** How long after its last ask the tunnel service counts as gone: it asks every 10 s. */
export const SERVICE_GONE_MS = 30_000;

/** The path the tunnel service asks for its settings at. */
export const AGENT_PATH = '/tunnel/agent';

export interface RemoteAccess {
  view(): RemoteAccessView;
  /** Applies a change of the hopper's admin's; throws HttpError 400 (invalid), 409 (not now) or 503 (no master key). */
  change(c: RemoteAccessChange, by: string): RemoteAccessView;
  /** The remote access URL while remote access is on; undefined: off. The Host guard reads it at each request. */
  url(): string | undefined;
  /** The tunnel watch: whether the URL is up, and the tunnel agent's addresses. */
  watch: TunnelWatch;
  /**
   * The tunnel service's ask: its key, and what it reports of ngrok. 404: this hopper has no tunnel service; 401: the key
   * is wrong. Else the settings it runs ngrok with, as `name=value` lines, or none (204) while remote access is off.
   */
  agent(ask: { key: string | undefined; report: unknown }): { status: 200; body: string } | { status: 204 } | { status: 401 | 404; error: string };
  stop(): Promise<void>;
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createRemoteAccess(o: {
  settings: Pick<InstanceSettingsRepository, 'getRemoteAccess' | 'setRemoteAccess'>;
  /** The instance's system secrets: the authtoken. */
  secrets: Pick<SystemSecrets, 'open' | 'meta' | 'keep' | 'drop' | 'problem'>;
  events: Pick<InstanceEvents, 'append'>;
  /** HOPPER_TUNNEL_API: the tunnel agent's local API. Undefined: the tunnel watch asks nothing. */
  tunnelApi: string | undefined;
  /**
   * The environment: HOPPER_TUNNEL_KEY (or its file), read at each ask — the stack makes the file again at each start;
   * unset: no tunnel service. And NGROK_AUTHTOKEN of an install from before (issue #795), moved into the settings once.
   */
  env: Record<string, string | undefined>;
  /** HOPPER_PUBLIC_URL: an install from before forwarded it; its domain is moved with NGROK_AUTHTOKEN. */
  publicUrl: string | undefined;
  now: () => Date;
  logger: { info(m: string): void; warn(m: string): void };
  watchEveryMs?: number;
}): RemoteAccess {
  const secret = runtimeSecrets(o.env);
  const serviceKey = (): string | undefined => { try { return secret(TUNNEL_KEY_VARIABLE); } catch { return undefined; } };
  let saved: RemoteAccessSettings = o.settings.getRemoteAccess() ?? { enabled: false };
  let seenAt: Date | undefined;
  let report: string | undefined;
  let unreadable: string | undefined;

  const url = (): string | undefined => (saved.enabled && saved.domain ? tunnelUrlOf(saved.domain) : undefined);
  const watch = watchTunnel({ api: o.tunnelApi, url, logger: o.logger, ...(o.watchEveryMs ? { everyMs: o.watchEveryMs } : {}) });
  const hasToken = (): boolean => o.secrets.meta(AUTHTOKEN_SECRET) !== undefined;

  function status(): RemoteAccessStatus {
    const seen = seenAt ? { serviceSeenAt: seenAt.toISOString() } : {};
    if (!saved.enabled) return { state: 'off', ...seen };
    if (serviceKey() === undefined) return { state: 'no-service', error: 'this hopper runs no tunnel service: the compose stack runs one (docs/deploy.md "Remote access")' };
    if (!seenAt || o.now().getTime() - seenAt.getTime() > SERVICE_GONE_MS) {
      return { state: 'no-service', ...seen, error: `the tunnel service has not asked for its settings ${seenAt ? 'for more than 30 s' : 'since the hopper started'}: start it with \`podman compose up -d\` beside the hopper's compose.yaml` };
    }
    if (unreadable) return { state: 'down', ...seen, error: unreadable };
    const up = watch.url();
    if (up) return { state: 'up', url: up, ...seen };
    const stopped = report !== undefined && report !== 'running' && report !== 'stopped' ? ngrokErrorText(report) : undefined;
    return { state: 'down', ...seen, error: stopped ?? watch.reason() ?? 'the tunnel is starting' };
  }

  function view(): RemoteAccessView {
    const meta = o.secrets.meta(AUTHTOKEN_SECRET);
    const problem = o.secrets.problem();
    return {
      enabled: saved.enabled,
      ...(saved.domain ? { domain: saved.domain, url: tunnelUrlOf(saved.domain) } : {}),
      ...(saved.restartedAt ? { restartedAt: saved.restartedAt } : {}),
      ...(meta ? { authtoken: { setBy: meta.setBy, setAt: meta.setAt, ...(meta.last4 ? { last4: meta.last4 } : {}) } } : {}),
      service: serviceKey() !== undefined,
      status: status(),
      ...(problem ? { problem } : {}),
    };
  }

  function save(next: RemoteAccessSettings, by: string, authtoken?: 'set' | 'removed'): void {
    const from = saved;
    if (from.enabled === next.enabled && from.domain === next.domain && from.restartedAt === next.restartedAt && authtoken === undefined) return;
    o.settings.setRemoteAccess(next);
    saved = next;
    // A new token or domain, or a restart, is tried afresh: what ngrok said before is not this one's.
    if (authtoken !== undefined || from.domain !== next.domain || from.restartedAt !== next.restartedAt || !next.enabled) report = undefined;
    o.events.append({ type: 'remote_access.changed', data: { from, to: next, ...(authtoken ? { authtoken } : {}), by } });
  }

  /** Moves NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL of an install from before (issue #795) into the settings, once. */
  function adopt(from: { authtoken: string | undefined; publicUrl: string | undefined }): void {
    const token = from.authtoken?.trim();
    if (!token || o.settings.getRemoteAccess() !== undefined) return;
    if (!AUTHTOKEN.test(token)) {
      o.logger.warn('hopper: NGROK_AUTHTOKEN is not an ngrok authtoken: not moved into Settings → Remote access');
      return;
    }
    const kept = o.secrets.keep(AUTHTOKEN_SECRET, token, 'hopper');
    if (!kept.ok) {
      o.logger.warn(`hopper: NGROK_AUTHTOKEN is not moved into Settings → Remote access yet: ${kept.error}`);
      return;
    }
    let domain: string | undefined;
    try {
      const u = from.publicUrl ? new URL(from.publicUrl) : undefined;
      const d = u?.protocol === 'https:' && u.port === '' ? domainOf(u.hostname) : undefined;
      domain = d && 'domain' in d ? d.domain : undefined;
    } catch { /* no domain: set it in the UI */ }
    save({ enabled: domain !== undefined, ...(domain ? { domain } : {}) }, 'hopper', 'set');
    watch.askNow();
    o.logger.info(`hopper: NGROK_AUTHTOKEN${domain ? ' and HOPPER_PUBLIC_URL' : ''} moved into Settings → Remote access${domain ? '; remote access is on' : ''}. Remove NGROK_AUTHTOKEN from .env`);
  }

  adopt({ authtoken: o.env.NGROK_AUTHTOKEN, publicUrl: o.publicUrl });
  return {
    view,
    url,
    watch,
    change(c, by) {
      let domain = saved.domain;
      if (c.domain === null) domain = undefined;
      else if (c.domain !== undefined) {
        const d = domainOf(c.domain);
        if ('error' in d) throw new HttpError(400, d.error);
        domain = d.domain;
      }
      if (typeof c.authtoken === 'string' && !AUTHTOKEN.test(c.authtoken.trim())) {
        throw new HttpError(400, 'the authtoken is letters, digits and underscores: copy it from https://dashboard.ngrok.com/get-started/your-authtoken');
      }
      const enabled = c.enabled ?? saved.enabled;
      const token = c.authtoken === null ? false : c.authtoken !== undefined || hasToken();
      if (enabled && (!domain || !token)) {
        throw new HttpError(409, `remote access needs ${!domain && !token ? 'the domain and the authtoken' : !domain ? 'the domain' : 'the authtoken'} first: ${saved.enabled ? 'turn it off to remove one' : 'set them, then turn it on'}`);
      }
      if (c.restart && !enabled) throw new HttpError(409, 'remote access is off: turn it on to start the tunnel');
      let authtoken: 'set' | 'removed' | undefined;
      if (typeof c.authtoken === 'string') {
        const kept = o.secrets.keep(AUTHTOKEN_SECRET, c.authtoken.trim(), by);
        if (!kept.ok) throw new HttpError(kept.code === 'unavailable' ? 503 : kept.code === 'invalid' ? 400 : 409, kept.error);
        authtoken = 'set';
        unreadable = undefined;
      } else if (c.authtoken === null && o.secrets.drop(AUTHTOKEN_SECRET, by)) authtoken = 'removed';
      const restartedAt = c.restart ? o.now().toISOString() : saved.restartedAt;
      save({ enabled, ...(domain ? { domain } : {}), ...(restartedAt ? { restartedAt } : {}) }, by, authtoken);
      watch.askNow();
      return view();
    },
    agent(ask) {
      const key = serviceKey();
      if (key === undefined) return { status: 404, error: 'this hopper runs no tunnel service: HOPPER_TUNNEL_KEY is not set' };
      if (ask.key === undefined || !same(ask.key, key)) return { status: 401, error: 'the tunnel service\'s key is wrong' };
      seenAt = o.now();
      if (typeof ask.report === 'string' && AGENT_REPORT.test(ask.report)) report = ask.report;
      const at = url();
      if (at === undefined) return { status: 204 };
      let token: string | undefined;
      try {
        token = o.secrets.open(AUTHTOKEN_SECRET, 'the tunnel service');
        unreadable = token === undefined ? 'no authtoken is kept: set it again' : undefined;
      } catch (e) {
        unreadable = `the authtoken cannot be opened: ${(e as Error).message}`;
      }
      if (token === undefined) return { status: 204 };
      return { status: 200, body: `url=${at}\nauthtoken=${token}\n${saved.restartedAt ? `restart=${saved.restartedAt}\n` : ''}` };
    },
    stop: () => watch.stop(),
  };
}

/**
 * GET /tunnel/agent: the tunnel service's ask (`Authorization: Bearer <HOPPER_TUNNEL_KEY>`, `?ngrok=<report>`). Off /api/
 * and off the tunnel's edge, which lets only the API through; refused as a public request too, so it is never answered
 * through the tunnel itself. It changes no job, question, webhook or setting: it records when the service asked and what
 * it said of ngrok, in memory.
 */
export function tunnelAgentRoutes(app: FastifyInstance, o: { remoteAccess: Pick<RemoteAccess, 'agent'>; isPublic: (req: FastifyRequest) => boolean }): void {
  app.get(AGENT_PATH, async (req, reply) => {
    if (o.isPublic(req)) return reply.code(404).send({ error: 'not found' });
    const key = /^Bearer\s+(\S+)\s*$/i.exec(typeof req.headers.authorization === 'string' ? req.headers.authorization : '')?.[1];
    const r = o.remoteAccess.agent({ key, report: (req.query as Record<string, unknown> | undefined)?.ngrok });
    reply.header('cache-control', 'no-store');
    if (r.status === 204) return reply.code(204).send();
    if (r.status === 200) return reply.type('text/plain; charset=utf-8').send(r.body);
    return reply.code(r.status).send({ error: r.error });
  });
}
