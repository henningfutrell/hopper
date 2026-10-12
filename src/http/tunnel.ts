// The tunnel watch (issues #795, #880, design.md "The tunnel", "Remote access"): the compose service `tunnel` runs an ngrok
// agent that forwards the remote access URL (`https://<domain>`, set in the UI) to the hopper. While remote access is on,
// the hopper asks that agent's local API (HOPPER_TUNNEL_API, on a network only the two of them share) every few seconds
// whether its endpoint at that URL is up, so a notifier can say where the hopper is reached (`hopper.reachable`) and
// Settings → Remote access can say why it is not. It only reads: the Host guard takes the URL from the settings alone,
// never a URL the agent reports. Each ask also looks up the agent's addresses: every request through the tunnel comes
// from the agent, and its edge names the caller in `x-hopper-caller`, so the sign-in limit counts each caller, not the
// agent (`tunnelCaller`).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface TunnelWatch {
  /** The remote access URL while the tunnel's endpoint there is up; undefined when it is down, off, or there is no tunnel. */
  url(): string | undefined;
  /** Why the tunnel is down, from the last ask; undefined when it is up, off, or not asked yet. */
  reason(): string | undefined;
  /** Whether a peer address is the tunnel agent's, as HOPPER_TUNNEL_API's host resolved at the last ask. */
  isAgent(peer: string): boolean;
  /** Asks now, not at the next tick (one ask in flight is enough): a change of the settings shows at once. */
  askNow(): void;
  /** Stops asking; settles an ask in flight. */
  stop(): Promise<void>;
}

export interface TunnelWatchOptions {
  /** HOPPER_TUNNEL_API: the agent's local API (`http://tunnel:4040`). Undefined: no tunnel, nothing asked. */
  api: string | undefined;
  /** The remote access URL while remote access is on (read at each ask); undefined: off, nothing asked. */
  url: () => string | undefined;
  logger: { info(m: string): void; warn(m: string): void };
  /** How often to ask. Default 10 s. */
  everyMs?: number;
}

const EVERY_MS = 10_000;
const TIMEOUT_MS = 5000;

/** The header the tunnel's edge sets to the caller's address (compose.yaml, its traffic policy); read from the agent only. */
export const CALLER_HEADER = 'x-hopper-caller';

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

/** Up (the public URL), or why it is down, from one answer of GET /api/tunnels. */
async function ask(api: string, publicUrl: string): Promise<{ up: string } | { down: string }> {
  let res: Response;
  try {
    res = await fetch(new URL('/api/tunnels', api), { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    return { down: `the tunnel agent at ${api} does not answer (${e instanceof Error ? e.message : String(e)})` };
  }
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

export function watchTunnel(o: TunnelWatchOptions): TunnelWatch {
  const { api, logger } = o;
  if (!api) return { url: () => undefined, reason: () => undefined, isAgent: () => false, askNow: () => undefined, stop: async () => undefined };
  let up: string | undefined;
  let down: string | undefined;
  let agent = new Set<string>();
  let last = '';
  let pass: Promise<void> | undefined;
  const check = async (): Promise<void> => {
    agent = await addressesOf(new URL(api).hostname);
    const publicUrl = o.url();
    const r = publicUrl === undefined ? undefined : await ask(api, publicUrl);
    // Turned off or changed while the ask was in flight: the next ask says.
    if (publicUrl !== o.url()) return;
    up = r && 'up' in r ? r.up : undefined;
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
  // Read through the settings now: a URL turned off or changed is not up a moment longer.
  const current = (): boolean => up !== undefined && up === o.url();
  return {
    url: () => (current() ? up : undefined),
    reason: () => (o.url() === undefined ? undefined : down),
    isAgent: (peer) => agent.has(unmapped(peer)),
    askNow: tick,
    async stop() {
      clearInterval(timer);
      await pass;
    },
  };
}

/**
 * Who a request counts as for a per-caller limit: the address in `x-hopper-caller` when the peer is the tunnel agent and
 * the header is one address; else the peer's own address. A peer that is not the agent cannot pick its count by a header.
 */
export const tunnelCaller = (tunnel: Pick<TunnelWatch, 'isAgent'>) => (req: { ip: string; headers: Record<string, string | string[] | undefined> }): string => {
  const named = req.headers[CALLER_HEADER];
  return tunnel.isAgent(req.ip) && typeof named === 'string' && isIP(named.trim()) !== 0 ? unmapped(named.trim()) : req.ip;
};
