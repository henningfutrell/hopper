// Remote access (issues #880, #968, design.md "Remote access"): the tunnel is set in the UI, never in a file on the host.
// Off by default. The hopper's admin picks a provider — Cloudflare Tunnel or ngrok — and gives its one credential (a
// system secret of the instance's vault), at POST /ui/api/remote-access. Turned on, the hopper mints the tunnel with it
// (src/remote-access/): its token (a system secret too), its host name and, at Cloudflare, its DNS record. Turned off or
// switched, it revokes and removes what it minted, and names what it could not. The compose services `tunnel` (ngrok) and
// `cloudflared` hold nothing: each asks the hopper every few seconds at GET /tunnel/agent, with the preshared key both
// read from a file in memory (HOPPER_TUNNEL_KEY, made at each start of the stack), and runs its agent only while its
// provider is the one on. Its ask reports what the agent did, which the status shows with the tunnel watch's word.
// A cluster install (issue #1289) has no compose stack: its status names none, and points at the chart's Ingress.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InstanceEvents, InstanceSettingsRepository } from '../domain/ports.ts';
import {
  AGENT_REPORT, agentErrorText, AUTHTOKEN, CREDENTIAL, CREDENTIAL_HELP, domainOf, linksOf, PROVIDER_NAME, PROVIDERS, tunnelUrlOf,
  type CredentialMeta, type Provisioned, type RemoteAccessChange, type RemoteAccessProvider, type RemoteAccessSettings,
  type RemoteAccessStatus, type RemoteAccessView,
} from '../domain/remote-access.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import { cloudflareProvider } from '../remote-access/cloudflare.ts';
import { ngrokProvider } from '../remote-access/ngrok.ts';
import { mintName, type TunnelProvider } from '../remote-access/provider.ts';
import type { SagaDefinition } from '../sagas/coordinator.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { runtimeSecrets } from '../secrets/runtime.ts';
import { inCluster } from '../client/cluster.ts';
import { HttpError } from './errors.ts';
import { MINT_SAGA, mintSagas, settleMints, type MintSagas } from './remote-access-mint.ts';
import { watchTunnel, type TunnelWatch } from './tunnel.ts';

/** The admin's credential for each provider: what the hopper mints the tunnel with. */
export const CREDENTIAL_SECRET = {
  cloudflare: 'remote-access.cloudflare-api-token', ngrok: 'remote-access.ngrok-api-key',
} as const satisfies Record<RemoteAccessProvider, SystemSecretName>;

/** The token each tunnel service runs its agent with: minted by the hopper (an ngrok authtoken given by hand before #968 too). */
export const TOKEN_SECRET = {
  cloudflare: 'remote-access.cloudflare-tunnel-token', ngrok: 'remote-access.ngrok-authtoken',
} as const satisfies Record<RemoteAccessProvider, SystemSecretName>;

/** The tunnel services' preshared key: the variable, or the file `HOPPER_TUNNEL_KEY_FILE` names (the stack's, in memory). */
export const TUNNEL_KEY_VARIABLE = 'HOPPER_TUNNEL_KEY';

/** How long after its last ask a tunnel service counts as gone: it asks every 10 s. */
export const SERVICE_GONE_MS = 30_000;

/**
 * Why no tunnel service runs the agent now, or undefined: `service` asked within SERVICE_GONE_MS. `keyed`: the hopper has
 * the tunnel services' key; `at`: when the service last asked.
 */
export function tunnelServiceProblem(o: { service: string; cluster: boolean; keyed: boolean; at: Date | undefined; now: Date }): string | undefined {
  if (o.cluster && !o.keyed) return 'this hopper runs in a Kubernetes cluster, which runs no tunnel service: reach it through the chart\'s Ingress (docs/deploy.md "Remote access")';
  if (!o.keyed) return 'this hopper runs no tunnel service: the compose stack runs them (docs/deploy.md "Remote access")';
  if (o.at && o.now.getTime() - o.at.getTime() <= SERVICE_GONE_MS) return undefined;
  const since = o.at ? 'for more than 30 s' : 'since the hopper started';
  return o.cluster
    ? `the ${o.service} service has not asked for its settings ${since}: check that it runs in the cluster`
    : `the ${o.service} service has not asked for its settings ${since}: start it with \`podman compose up -d\` beside the hopper's compose.yaml`;
}

/** The path the tunnel services ask for their settings at. */
export const AGENT_PATH = '/tunnel/agent';

export interface RemoteAccess {
  view(): RemoteAccessView;
  /**
   * Applies a change of the hopper's admin's: mints the tunnel when it is turned on, releases it when it is turned off or
   * switched. Throws HttpError 400 (invalid), 409 (not now), 502 (the provider refused; nothing is left minted) or 503 (no
   * master key).
   */
  change(c: RemoteAccessChange, by: string): Promise<RemoteAccessView>;
  /** The remote access URL while remote access is on; undefined: off. The Host guard reads it at each request. */
  url(): string | undefined;
  /** The tunnel watch: whether the URL is up, and the tunnel agents' addresses. */
  watch: TunnelWatch;
  /**
   * A tunnel service's ask: its key, its provider, and what it reports of its agent. 404: this hopper has no tunnel
   * service; 401: the key is wrong. Else the settings it runs its agent with, as `name=value` lines, or none (204) while
   * remote access is off or another provider's.
   */
  agent(ask: { key: string | undefined; provider: RemoteAccessProvider; report: unknown }): { status: 200; body: string } | { status: 204 } | { status: 401 | 404; error: string };
  stop(): Promise<void>;
  /** The mint's saga kinds, one per provider: the composition root gives them to the coordinator. */
  sagas: SagaDefinition[];
}

const same = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Whether the hopper minted it, so a release revokes it: an ngrok authtoken given by hand before #968 is kept. */
const minted = (p: Provisioned): boolean => p.provider === 'cloudflare' || p.credentialId !== undefined;

export function createRemoteAccess(o: {
  settings: Pick<InstanceSettingsRepository, 'getRemoteAccess' | 'setRemoteAccess'>;
  /** The instance's system secrets: the credentials and the tunnel tokens. */
  secrets: Pick<SystemSecrets, 'open' | 'meta' | 'keep' | 'drop' | 'problem'>;
  events: Pick<InstanceEvents, 'append'>;
  /** Each tunnel agent's local API: HOPPER_TUNNEL_API, HOPPER_CLOUDFLARED_API. Unset: the tunnel watch asks none. */
  tunnelApis: Partial<Record<RemoteAccessProvider, string>>;
  /** The providers' APIs; default the real ones (tests: loopback fakes). */
  providers?: Record<RemoteAccessProvider, TunnelProvider>;
  /** The sagas the mint runs on (issue #1609). */
  mints: MintSagas;
  /** The instance's id: the fixed name of what a mint makes at the provider. */
  instanceId: string;
  /** The hopper's port: where the tunnel forwards to (`http://hopper:<port>`). */
  port: () => number;
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
  const providers = o.providers ?? { cloudflare: cloudflareProvider(), ngrok: ngrokProvider() };
  const secret = runtimeSecrets(o.env);
  const serviceKey = (): string | undefined => { try { return secret(TUNNEL_KEY_VARIABLE); } catch { return undefined; } };
  let saved: RemoteAccessSettings = o.settings.getRemoteAccess() ?? { enabled: false };
  const seenAt: Partial<Record<RemoteAccessProvider, Date>> = {};
  const report: Partial<Record<RemoteAccessProvider, string>> = {};
  let unreadable: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const url = (): string | undefined => (saved.enabled && saved.provisioned ? tunnelUrlOf(saved.provisioned.domain) : undefined);
  const watch = watchTunnel({
    apis: o.tunnelApis, logger: o.logger, ...(o.watchEveryMs ? { everyMs: o.watchEveryMs } : {}),
    target: () => { const u = url(); return u && saved.provisioned ? { provider: saved.provisioned.provider, url: u } : undefined; },
  });
  const meta = (name: SystemSecretName): CredentialMeta | undefined => {
    const m = o.secrets.meta(name);
    return m ? { setBy: m.setBy, setAt: m.setAt, ...(m.last4 ? { last4: m.last4 } : {}) } : undefined;
  };
  const open = (name: SystemSecretName, purpose: string): string | undefined => {
    try { return o.secrets.open(name, purpose); } catch (e) { throw new HttpError(503, `the ${name} system secret cannot be opened: ${(e as Error).message}`); }
  };

  function status(): RemoteAccessStatus {
    const p = saved.provisioned?.provider;
    const at = p ? seenAt[p] : undefined;
    const seen = at ? { serviceSeenAt: at.toISOString() } : {};
    if (!saved.enabled || !p) return { state: 'off' };
    const service = p === 'cloudflare' ? 'cloudflared' : 'tunnel';
    const keyed = serviceKey() !== undefined;
    const gone = tunnelServiceProblem({ service, cluster: inCluster(o.env), keyed, at, now: o.now() });
    if (gone) return { state: 'no-service', ...(keyed ? seen : {}), error: gone };
    if (unreadable) return { state: 'down', ...seen, error: unreadable };
    const up = watch.url();
    if (up) return { state: 'up', url: up, ...seen };
    const r = report[p];
    const stopped = r !== undefined && r !== 'running' && r !== 'stopped' ? agentErrorText(p, r) : undefined;
    return { state: 'down', ...seen, error: stopped ?? watch.reason() ?? 'the tunnel is starting' };
  }

  function view(): RemoteAccessView {
    const problem = o.secrets.problem();
    const credentials: RemoteAccessView['credentials'] = {};
    for (const p of PROVIDERS) { const m = meta(CREDENTIAL_SECRET[p]); if (m) credentials[p] = m; }
    const at = url();
    return {
      enabled: saved.enabled,
      ...(saved.provider ? { provider: saved.provider } : {}),
      ...(saved.domain ? { domain: saved.domain } : {}),
      ...(saved.restartedAt ? { restartedAt: saved.restartedAt } : {}),
      ...(saved.provisioned ? { url: tunnelUrlOf(saved.provisioned.domain), provisioned: { provider: saved.provisioned.provider, domain: saved.provisioned.domain } } : {}),
      ...(at ? { links: linksOf(at) } : {}),
      credentials,
      ...(saved.leftover?.length ? { leftover: saved.leftover } : {}),
      service: serviceKey() !== undefined,
      status: status(),
      ...(problem ? { problem } : {}),
    };
  }

  function save(next: RemoteAccessSettings, by: string, credential?: 'set' | 'removed'): void {
    const from = saved;
    if (JSON.stringify(from) === JSON.stringify(next) && credential === undefined) return;
    o.settings.setRemoteAccess(next);
    saved = next;
    // A new tunnel or a restart is tried afresh: what an agent said before is not this one's.
    if (from.provisioned !== next.provisioned || from.restartedAt !== next.restartedAt || !next.enabled) {
      for (const p of PROVIDERS) delete report[p];
      unreadable = undefined;
    }
    o.events.append({ type: 'remote_access.changed', data: { from, to: next, ...(credential ? { credential } : {}), by } });
  }

  /** Revokes and removes what the hopper minted; what it could not, in words. The token it ran with is dropped. */
  async function release(p: Provisioned, by: string): Promise<string[]> {
    const credential = open(CREDENTIAL_SECRET[p.provider], 'remote access: release the tunnel');
    const left = minted(p) ? await providers[p.provider].release({ credential, provisioned: p }) : [];
    o.secrets.drop(TOKEN_SECRET[p.provider], by);
    if (left.length > 0) o.logger.warn(`hopper: remote access: ${PROVIDER_NAME[p.provider]} kept what the hopper could not remove: ${left.join('; ')}`);
    return left;
  }

  async function apply(c: RemoteAccessChange, by: string): Promise<RemoteAccessView> {
    if (!await settleMints(o.mints)) throw new HttpError(409, 'the hopper still removes what an earlier mint of the tunnel made: try again in a minute');
    const provider = c.provider ?? saved.provider;
    let domain = saved.domain;
    if (c.domain === null) domain = undefined;
    else if (c.domain !== undefined) {
      const d = domainOf(c.domain);
      if ('error' in d) throw new HttpError(400, d.error);
      domain = d.domain;
    }
    if (c.credential !== undefined && provider === undefined) throw new HttpError(409, 'pick a provider first: the credential is that provider\'s');
    if (typeof c.credential === 'string' && provider && !CREDENTIAL[provider].test(c.credential.trim())) {
      throw new HttpError(400, `that is no ${PROVIDER_NAME[provider]} ${CREDENTIAL_HELP[provider].name}: make one at ${CREDENTIAL_HELP[provider].where}`);
    }
    const enabled = c.enabled ?? saved.enabled;
    if (enabled && provider === undefined) throw new HttpError(409, 'pick a provider first: Cloudflare Tunnel or ngrok');
    if (c.restart && !enabled) throw new HttpError(409, 'remote access is off: turn it on to start the tunnel');
    const p = saved.provisioned;
    if (c.credential === null && saved.enabled && enabled && p?.provider === provider) {
      throw new HttpError(409, 'the tunnel runs on that credential: turn remote access off to remove it');
    }
    if (o.secrets.problem() && (typeof c.credential === 'string' || (enabled && !saved.enabled))) throw new HttpError(503, o.secrets.problem()!);

    const next: RemoteAccessSettings = { ...saved, enabled, ...(provider ? { provider } : {}) };
    if (domain) next.domain = domain; else delete next.domain;
    if (c.restart) next.restartedAt = o.now().toISOString();
    // What is minted no longer fits: turned off (a token given by hand stays), another provider, another host name, or a
    // new credential for it.
    if (p) {
      const fits = enabled
        ? p.provider === provider && (domain === undefined || domain === p.domain) && !(typeof c.credential === 'string' && c.credential.trim() !== '')
        : !minted(p);
      if (!fits) {
        const left = await release(p, by);
        delete next.provisioned;
        if (left.length > 0) next.leftover = left; else delete next.leftover;
      }
    }
    let credential: 'set' | 'removed' | undefined;
    if (typeof c.credential === 'string' && provider) {
      const kept = o.secrets.keep(CREDENTIAL_SECRET[provider], c.credential.trim(), by);
      if (!kept.ok) throw new HttpError(kept.code === 'unavailable' ? 503 : kept.code === 'invalid' ? 400 : 409, kept.error);
      credential = 'set';
    } else if (c.credential === null && provider && o.secrets.drop(CREDENTIAL_SECRET[provider], by)) credential = 'removed';

    if (enabled && provider && !next.provisioned) {
      const key = open(CREDENTIAL_SECRET[provider], 'remote access: mint the tunnel');
      if (key === undefined) {
        save({ ...next, enabled: false }, by, credential);
        throw new HttpError(409, `remote access with ${PROVIDER_NAME[provider]} needs its ${CREDENTIAL_HELP[provider].name} first: make one at ${CREDENTIAL_HELP[provider].where} (${CREDENTIAL_HELP[provider].needs})`);
      }
      // Begun before the settings ask for it: a stop between the two leaves a saga whose record is refused, so it undoes itself.
      const saga = o.mints.begin(MINT_SAGA[provider], randomUUID(), { ...(domain ? { domain } : {}), port: o.port(), name: mintName(o.instanceId), by });
      save(next, by, credential);
      const end = await o.mints.drive(saga.id);
      if (end && end.state !== 'done' && (end.state !== 'running' || end.steps.some((t) => t.lastError))) {
        const why = end.steps.find((t) => t.state === 'pending' && t.lastError)?.lastError ?? end.error ?? 'the mint did not go through';
        o.mints.abort(saga.id, why);
        await o.mints.drive(saga.id);
        throw new HttpError(502, `${PROVIDER_NAME[provider]} did not mint the tunnel: ${why}`);
      }
      watch.askNow();
      return view();
    }
    save(next, by, credential);
    watch.askNow();
    return view();
  }

  /** Moves NGROK_AUTHTOKEN and HOPPER_PUBLIC_URL of an install from before (issue #795) into the settings, once. */
  function adopt(from: { authtoken: string | undefined; publicUrl: string | undefined }): void {
    const token = from.authtoken?.trim();
    if (!token || o.settings.getRemoteAccess() !== undefined) return;
    if (!AUTHTOKEN.test(token)) {
      o.logger.warn('hopper: NGROK_AUTHTOKEN is not an ngrok authtoken: not moved into Settings → Remote access');
      return;
    }
    const kept = o.secrets.keep(TOKEN_SECRET.ngrok, token, 'hopper');
    if (!kept.ok) {
      o.logger.warn(`hopper: NGROK_AUTHTOKEN is not moved into Settings → Remote access yet: ${kept.error}`);
      return;
    }
    let domain: string | undefined;
    try {
      const u = from.publicUrl ? new URL(from.publicUrl) : undefined;
      const d = u?.protocol === 'https:' && u.port === '' ? domainOf(u.hostname) : undefined;
      domain = d && 'domain' in d ? d.domain : undefined;
    } catch { /* no domain: mint one with an API key */ }
    save({ enabled: domain !== undefined, provider: 'ngrok', ...(domain ? { domain, provisioned: { provider: 'ngrok', domain } } : {}) }, 'hopper');
    watch.askNow();
    o.logger.info(`hopper: NGROK_AUTHTOKEN${domain ? ' and HOPPER_PUBLIC_URL' : ''} moved into Settings → Remote access${domain ? '; remote access is on' : ''}. Remove NGROK_AUTHTOKEN from .env`);
  }

  adopt({ authtoken: o.env.NGROK_AUTHTOKEN, publicUrl: o.publicUrl });
  return {
    view,
    url,
    watch,
    change(c, by) {
      // One change at a time: each may call a provider, and the next reads what the last one minted.
      const run = queue.then(() => apply(c, by));
      queue = run.catch(() => undefined);
      return run;
    },
    agent(ask) {
      const key = serviceKey();
      if (key === undefined) return { status: 404, error: 'this hopper runs no tunnel service: HOPPER_TUNNEL_KEY is not set' };
      if (ask.key === undefined || !same(ask.key, key)) return { status: 401, error: 'the tunnel service\'s key is wrong' };
      seenAt[ask.provider] = o.now();
      if (typeof ask.report === 'string' && AGENT_REPORT[ask.provider].test(ask.report)) report[ask.provider] = ask.report;
      const at = url();
      if (at === undefined || saved.provisioned?.provider !== ask.provider) return { status: 204 };
      let token: string | undefined;
      try {
        token = o.secrets.open(TOKEN_SECRET[ask.provider], 'the tunnel service');
        unreadable = token === undefined ? 'no tunnel token is kept: turn remote access off and on again to mint one' : undefined;
      } catch (e) {
        unreadable = `the tunnel token cannot be opened: ${(e as Error).message}`;
      }
      if (token === undefined) return { status: 204 };
      const restart = saved.restartedAt ? `restart=${saved.restartedAt}\n` : '';
      return { status: 200, body: ask.provider === 'ngrok' ? `url=${at}\nauthtoken=${token}\n${restart}` : `token=${token}\n${restart}` };
    },
    stop: () => watch.stop(),
    sagas: mintSagas({
      providers,
      host: {
        credential: (p) => open(CREDENTIAL_SECRET[p], 'remote access: mint the tunnel'),
        keepToken(p, token, by) {
          const kept = o.secrets.keep(TOKEN_SECRET[p], token, by);
          if (!kept.ok) throw new Error(kept.error);
        },
        minted(p, provisioned, d) {
          // Kept already: a try again after a crash between this write and the saga's record of it (issue #1954).
          if (saved.enabled && saved.provider === p && saved.domain === d.domain && JSON.stringify(saved.provisioned) === JSON.stringify(provisioned)) return;
          if (!saved.enabled || saved.provider !== p || saved.provisioned || saved.domain !== d.domain) throw new Error('the remote access settings no longer ask for this tunnel');
          save({ ...saved, provisioned }, d.by);
          o.logger.info(`hopper: remote access: minted a tunnel at ${PROVIDER_NAME[p]}: ${tunnelUrlOf(provisioned.domain)}`);
          watch.askNow();
        },
        async unminted(p, found, reason, by) {
          const left = found ? await providers[p].release({ credential: open(CREDENTIAL_SECRET[p], 'remote access: release the tunnel'), provisioned: found }) : [];
          o.secrets.drop(TOKEN_SECRET[p], by);
          const wants = saved.enabled && saved.provider === p && !saved.provisioned;
          if (wants || left.length > 0) save({ ...saved, ...(wants ? { enabled: false } : {}), ...(left.length > 0 ? { leftover: left } : {}) }, by);
          o.logger.warn(`hopper: remote access: the mint at ${PROVIDER_NAME[p]} is undone (${reason})${left.length > 0 ? `; it kept what the hopper could not remove: ${left.join('; ')}` : ''}`);
        },
      },
    }),
  };
}

/**
 * GET /tunnel/agent: a tunnel service's ask (`Authorization: Bearer <HOPPER_TUNNEL_KEY>`; `?ngrok=<report>` from the
 * ngrok service, `?cloudflared=<report>` from the cloudflared service). Off /api/ and off the tunnel's edge, which lets
 * only the API through; refused as a public request too, so it is never answered through a tunnel itself. It changes no
 * job, question, webhook or setting: it records when the service asked and what it said of its agent, in memory.
 */
export function tunnelAgentRoutes(app: FastifyInstance, o: { remoteAccess: Pick<RemoteAccess, 'agent'>; isPublic: (req: FastifyRequest) => boolean }): void {
  app.get(AGENT_PATH, async (req, reply) => {
    if (o.isPublic(req)) return reply.code(404).send({ error: 'not found' });
    const key = /^Bearer\s+(\S+)\s*$/i.exec(typeof req.headers.authorization === 'string' ? req.headers.authorization : '')?.[1];
    const q = (req.query as Record<string, unknown> | undefined) ?? {};
    const cloudflared = q.cloudflared !== undefined;
    const r = o.remoteAccess.agent({ key, provider: cloudflared ? 'cloudflare' : 'ngrok', report: cloudflared ? q.cloudflared : q.ngrok });
    reply.header('cache-control', 'no-store');
    if (r.status === 204) return reply.code(204).send();
    if (r.status === 200) return reply.type('text/plain; charset=utf-8').send(r.body);
    return reply.code(r.status).send({ error: r.error });
  });
}
