// The tunnel watch (issues #795, #880, #968, design.md "The tunnel", "Remote access"): a tunnel service of the compose stack
// runs the tunnel agent of the provider picked — `tunnel` runs ngrok, `cloudflared` Cloudflare's — which forwards the
// remote access URL (`https://<domain>`, minted by the hopper) to the hopper. While remote access is on, the hopper asks
// that agent's local API every few seconds whether it is up — ngrok's `GET /api/tunnels` has an endpoint at that URL;
// cloudflared's `GET /ready` has a connection to Cloudflare —, so a notifier can say where the hopper is reached
// (`hopper.reachable`) and Settings → Remote access can say why it is not. It only reads: the Host guard takes the URL from
// the settings alone, never a URL an agent reports. Each ask also looks up both agents' addresses: every request through a
// tunnel comes from its agent, which names the caller (ngrok's edge in `x-hopper-caller`, Cloudflare's in
// `cf-connecting-ip`), so a limit counts each caller, not the agent (`tunnelCaller`), and the tunnel's edge holds in the
// hopper too (`installTunnelEdge`).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { throughTheTunnel, tokenPath, TUNNEL_RATE, type RemoteAccessProvider } from '../domain/remote-access.ts';

export interface TunnelWatch {
  /** The remote access URL while the tunnel there is up; undefined when it is down, off, or there is no tunnel. */
  url(): string | undefined;
  /** Why the tunnel is down, from the last ask; undefined when it is up, off, or not asked yet. */
  reason(): string | undefined;
  /** Whose tunnel agent a peer address is, as each agent's host resolved at the last ask; undefined: none's. */
  agentOf(peer: string | undefined): RemoteAccessProvider | undefined;
  /** Asks now, not at the next tick (one ask in flight is enough): a change of the settings shows at once. */
  askNow(): void;
  /** Stops asking; settles an ask in flight. */
  stop(): Promise<void>;
}

export interface TunnelWatchOptions {
  /** Each agent's local API: HOPPER_TUNNEL_API (`http://tunnel:4040`), HOPPER_CLOUDFLARED_API (`http://cloudflared:2000`). */
  apis: Partial<Record<RemoteAccessProvider, string>>;
  /** The provider and the remote access URL while remote access is on (read at each ask); undefined: off, nothing asked. */
  target: () => { provider: RemoteAccessProvider; url: string } | undefined;
  logger: { info(m: string): void; warn(m: string): void };
  /** How often to ask. Default 10 s. */
  everyMs?: number;
}

const EVERY_MS = 10_000;
const TIMEOUT_MS = 5000;

/** The header each provider's edge names the caller's address in; read from that provider's agent only. */
export const CALLER_HEADER: Record<RemoteAccessProvider, string> = { ngrok: 'x-hopper-caller', cloudflare: 'cf-connecting-ip' };

/** `::ffff:a.b.c.d` → `a.b.c.d`; anything else unchanged. */
const unmapped = (a: string): string => (a.toLowerCase().startsWith('::ffff:') && isIP(a.slice(7)) === 4 ? a.slice(7) : a);

/** The addresses a host name resolves to now; none when it does not resolve. */
async function addressesOf(host: string): Promise<Set<string>> {
  try {
    return new Set((await lookup(host.replace(/^\[|\]$/g, ''), { all: true })).map((a) => unmapped(a.address)));
  } catch {
    return new Set();
  }
}

const originOf = (u: unknown): string | undefined => {
  try { return typeof u === 'string' ? new URL(u).origin : undefined; } catch { return undefined; }
};

async function get(api: string, path: string, agent: string): Promise<Response | { down: string }> {
  try {
    return await fetch(new URL(path, api), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { down: `the ${agent} agent at ${api} does not answer (${e instanceof Error ? e.message : String(e)})` };
  }
}

/** Up (the public URL), or why it is down, from one answer of the agent's local API. */
async function ask(provider: RemoteAccessProvider, api: string, publicUrl: string): Promise<{ up: string } | { down: string }> {
  if (provider === 'cloudflare') {
    const res = await get(api, '/ready', 'cloudflared');
    if ('down' in res) return res;
    await res.body?.cancel();
    return res.ok ? { up: publicUrl } : { down: `cloudflared has no connection to Cloudflare yet (HTTP ${res.status}): it starts with the tunnel token, or the token was revoked` };
  }
  const res = await get(api, '/api/tunnels', 'ngrok');
  if ('down' in res) return res;
  if (!res.ok) {
    await res.body?.cancel();
    return { down: `the tunnel agent answered HTTP ${res.status}` };
  }
  const body = (await res.json().catch(() => undefined)) as { tunnels?: { public_url?: unknown }[] } | undefined;
  const urls = (Array.isArray(body?.tunnels) ? body.tunnels : []).map((t) => originOf(t.public_url)).filter((u) => u !== undefined);
  if (urls.includes(publicUrl)) return { up: publicUrl };
  if (urls.length === 0) return { down: 'the tunnel agent has no endpoint (not signed in to ngrok yet, or reconnecting)' };
  return { down: `the tunnel's endpoint is not the remote access URL (${publicUrl}): ${urls.join(', ')}; the Host guard refuses it` };
}

const key = (t: { provider: RemoteAccessProvider; url: string } | undefined): string => (t ? `${t.provider} ${t.url}` : '');

export function watchTunnel(o: TunnelWatchOptions): TunnelWatch {
  const { apis, logger } = o;
  const providers = (Object.keys(apis) as RemoteAccessProvider[]).filter((p) => apis[p]);
  if (providers.length === 0) return { url: () => undefined, reason: () => undefined, agentOf: () => undefined, askNow: () => undefined, stop: async () => undefined };
  let up: string | undefined;
  let upFor = '';
  let down: string | undefined;
  let agents = new Map<string, RemoteAccessProvider>();
  let last = '';
  let pass: Promise<void> | undefined;
  const check = async (): Promise<void> => {
    const found = new Map<string, RemoteAccessProvider>();
    for (const p of providers) for (const a of await addressesOf(new URL(apis[p]!).hostname)) found.set(a, p);
    agents = found;
    const target = o.target();
    const api = target ? apis[target.provider] : undefined;
    const r = target === undefined ? undefined
      : api === undefined ? { down: `this hopper asks no ${target.provider === 'cloudflare' ? 'cloudflared' : 'ngrok'} agent (${target.provider === 'cloudflare' ? 'HOPPER_CLOUDFLARED_API' : 'HOPPER_TUNNEL_API'} is not set)` }
        : await ask(target.provider, api, target.url);
    // Turned off or changed while the ask was in flight: the next ask says.
    if (key(target) !== key(o.target())) return;
    up = r && 'up' in r ? r.up : undefined;
    upFor = up ? key(target) : '';
    down = r && 'down' in r ? r.down : undefined;
    const now = r === undefined ? 'off' : 'up' in r ? `up ${r.up}` : `down ${r.down}`;
    if (now === last) return;
    last = now;
    if (r === undefined) logger.info('hopper: remote access is off: the tunnel watch asks nothing');
    else if ('up' in r) logger.info(`hopper: the tunnel is up: ${r.up}`);
    else logger.warn(`hopper: the tunnel is down: ${r.down}`);
  };
  const tick = (): void => { pass ??= check().finally(() => { pass = undefined; }); };
  tick();
  const timer = setInterval(tick, o.everyMs ?? EVERY_MS);
  timer.unref();
  // Read through the settings now: a URL or a provider turned off or changed is not up a moment longer.
  const current = (): boolean => up !== undefined && upFor === key(o.target());
  return {
    url: () => (current() ? up : undefined),
    reason: () => (o.target() === undefined ? undefined : down),
    agentOf: (peer) => (peer === undefined ? undefined : agents.get(unmapped(peer))),
    askNow: tick,
    async stop() {
      clearInterval(timer);
      await pass;
    },
  };
}

type Req = { ip: string; headers: Record<string, string | string[] | undefined> };

/**
 * Who a request counts as for a per-caller limit: the address the agent's edge names when the peer is a tunnel agent and
 * its header is one address; else the peer's own address. A peer that is not that agent cannot pick its count by a header.
 */
export const tunnelCaller = (tunnel: Pick<TunnelWatch, 'agentOf'>) => (req: Req): string => {
  const agent = tunnel.agentOf(req.ip);
  const named = agent ? req.headers[CALLER_HEADER[agent]] : undefined;
  return typeof named === 'string' && isIP(named.trim()) !== 0 ? unmapped(named.trim()) : req.ip;
};

const WINDOW_MS = 60_000;

/**
 * The tunnel's edge, held in the hopper too (issues #795, #968): a request through the tunnel — from a tunnel agent, with
 * the remote access domain as its Host — reaches only the API (`throughTheTunnel`), else 404, and each caller has
 * TUNNEL_RATE requests a minute and its token-route share of it, else 429. ngrok's traffic policy says the same at its
 * edge; Cloudflare's ingress lets only the API paths through, and the limit is here alone. The agent's own ask of its
 * settings names the hopper as its Host, so it is not one. A count of its own, not @fastify/rate-limit: that plugin limits
 * the routes of one context, and this is one gate before every route.
 */
export function installTunnelEdge(app: FastifyInstance, o: { tunnel: Pick<TunnelWatch, 'agentOf'>; domain: () => string | undefined; now?: () => number }): void {
  const now = o.now ?? Date.now;
  const caller = tunnelCaller(o.tunnel);
  const counts = new Map<string, { start: number; n: number }>();
  const over = (k: string, max: number, at: number): boolean => {
    let c = counts.get(k);
    if (!c || at - c.start >= WINDOW_MS) {
      if (counts.size > 10_000) for (const [x, v] of counts) if (at - v.start >= WINDOW_MS) counts.delete(x);
      c = { start: at, n: 0 };
      counts.set(k, c);
    }
    c.n += 1;
    return c.n > max;
  };
  app.addHook('onRequest', async (req, reply) => {
    const domain = o.domain();
    if (domain === undefined || o.tunnel.agentOf(req.socket.remoteAddress) === undefined) return;
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
    if (host !== domain) return;
    if (!throughTheTunnel(req.url)) return reply.code(404).send({ error: 'not found' });
    const who = caller({ ip: req.socket.remoteAddress ?? req.ip, headers: req.headers });
    const at = now();
    if (over(`r ${who}`, TUNNEL_RATE.requests, at) || (tokenPath(req.url) && over(`t ${who}`, TUNNEL_RATE.tokens, at))) {
      return reply.code(429).header('retry-after', '60').send({ error: 'too many requests through the tunnel: wait a minute' });
    }
  });
}
