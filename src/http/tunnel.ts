// The tunnel watch (issue #795, design.md "The tunnel"): the compose profile `tunnel` runs an ngrok agent that forwards
// HOPPER_PUBLIC_URL to the hopper. The hopper asks that agent's local API (HOPPER_TUNNEL_API, on a network only the two of
// them share) every few seconds whether its endpoint at the public URL is up, so a notifier can say where the hopper is
// reached (`hopper.reachable`). It only reads: the Host guard takes HOPPER_PUBLIC_URL alone, never a URL the agent reports.

export interface TunnelWatch {
  /** HOPPER_PUBLIC_URL while the tunnel's endpoint there is up; undefined when it is down, or there is no tunnel. */
  url(): string | undefined;
  /** Stops asking; settles an ask in flight. */
  stop(): Promise<void>;
}

export interface TunnelWatchOptions {
  /** HOPPER_TUNNEL_API: the agent's local API (`http://tunnel:4040`). Undefined: no tunnel, nothing asked. */
  api: string | undefined;
  publicUrl: string | undefined;
  logger: { info(m: string): void; warn(m: string): void };
  /** How often to ask. Default 10 s. */
  everyMs?: number;
}

const EVERY_MS = 10_000;
const TIMEOUT_MS = 5000;

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
  return { down: `the tunnel's endpoint is not HOPPER_PUBLIC_URL (${publicUrl}): ${urls.join(', ')}; the Host guard refuses it` };
}

export function watchTunnel(o: TunnelWatchOptions): TunnelWatch {
  const { api, publicUrl, logger } = o;
  if (!api || !publicUrl) return { url: () => undefined, stop: async () => undefined };
  let up: string | undefined;
  let last = '';
  let pass: Promise<void> | undefined;
  const check = async (): Promise<void> => {
    const r = await ask(api, publicUrl);
    up = 'up' in r ? r.up : undefined;
    const now = 'up' in r ? `up ${r.up}` : `down ${r.down}`;
    if (now === last) return;
    last = now;
    if ('up' in r) logger.info(`hopper: the tunnel is up: ${r.up}`);
    else logger.warn(`hopper: the tunnel is down: ${r.down}`);
  };
  const tick = (): void => { pass ??= check().finally(() => { pass = undefined; }); };
  tick();
  const timer = setInterval(tick, o.everyMs ?? EVERY_MS);
  timer.unref();
  return {
    url: () => up,
    async stop() {
      clearInterval(timer);
      await pass;
    },
  };
}
