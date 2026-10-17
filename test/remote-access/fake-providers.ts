// Loopback fakes of Cloudflare's and ngrok's APIs (issues #968, #1609): each keeps what was made, so a test sees a mint
// make it and a release remove it. Only the calls the hopper makes; a call it does not know is 404. `hang` makes a later
// call go through and never answer, as when the hopper stops after the call.
import { createServer, type Server } from 'node:http';

export interface Fake {
  url: string;
  /** Every call, `METHOD path`, with its authorization. */
  calls: { line: string; auth: string | undefined; body: unknown }[];
  /** The `n`th call from now has its effect and is never answered; resolves when it came. */
  hang(n: number): Promise<void>;
  close(): Promise<void>;
}

type Route = (m: string, path: string, body: unknown) => { status: number; body: unknown } | undefined;

async function serve(route: Route): Promise<{ url: string; server: Server; calls: Fake['calls']; hang: Fake['hang'] }> {
  const calls: Fake['calls'] = [];
  let hangAt: { call: number; came(): void } | undefined;
  const hang = (n: number): Promise<void> => new Promise((came) => { hangAt = { call: calls.length + n, came }; });
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw === '' ? undefined : JSON.parse(raw) as unknown;
      calls.push({ line: `${req.method} ${req.url}`, auth: req.headers.authorization, body });
      const r = route(req.method ?? 'GET', req.url ?? '', body) ?? { status: 404, body: { errors: [{ code: 7003, message: 'not found' }], msg: 'not found' } };
      if (hangAt?.call === calls.length) {
        hangAt.came();
        hangAt = undefined;
        return;
      }
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, server, calls, hang };
}

const closer = (s: Server) => () => new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });

export interface FakeCloudflare extends Fake {
  tunnels: Map<string, { name: string; ingress?: unknown }>;
  records: Map<string, { name: string; content: string; proxied: boolean }>;
}

/** Cloudflare: one account `acc1`, the zones named, the API token `token` alone. */
export async function fakeCloudflare(o: { token: string; zones?: string[]; failDns?: boolean }): Promise<FakeCloudflare> {
  const tunnels: FakeCloudflare['tunnels'] = new Map();
  const records: FakeCloudflare['records'] = new Map();
  let n = 0;
  const ok = (result: unknown) => ({ status: 200, body: { success: true, errors: [], result } });
  const zones = (o.zones ?? ['example.com']).map((name, i) => ({ id: `zone${i + 1}`, name, account: { id: 'acc1' } }));
  const s = await serve((m, path, body) => {
    const p = path.split('?')[0]!;
    if (p === '/zones' && m === 'GET') return ok(zones);
    let x: RegExpExecArray | null;
    const q = new URLSearchParams(path.split('?')[1] ?? '');
    if (p === '/accounts/acc1/cfd_tunnel' && m === 'GET') return ok([...tunnels].filter(([, t]) => t.name === q.get('name')).map(([id, t]) => ({ id, name: t.name })));
    if (p === '/accounts/acc1/cfd_tunnel' && m === 'POST') {
      if ([...tunnels.values()].some((t) => t.name === (body as { name: string }).name)) return { status: 409, body: { success: false, errors: [{ code: 1013, message: 'You already have a tunnel with this name.' }] } };
      const id = `tun${++n}`;
      tunnels.set(id, { name: (body as { name: string }).name });
      return ok({ id, name: (body as { name: string }).name });
    }
    if ((x = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)\/configurations$/.exec(p)) && m === 'PUT') {
      const t = tunnels.get(x[1]!);
      if (!t) return undefined;
      t.ingress = (body as { config: { ingress: unknown } }).config.ingress;
      return ok({});
    }
    if ((x = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)\/token$/.exec(p)) && m === 'GET') return tunnels.has(x[1]!) ? ok(`cf-tunnel-token-${x[1]}`) : undefined;
    if ((x = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)\/connections$/.exec(p)) && m === 'DELETE') return tunnels.has(x[1]!) ? ok(null) : undefined;
    if ((x = /^\/accounts\/acc1\/cfd_tunnel\/([^/]+)$/.exec(p)) && m === 'DELETE') return tunnels.delete(x[1]!) ? ok({}) : undefined;
    if (/^\/zones\/[^/]+\/dns_records$/.test(p) && m === 'GET') return ok([...records].filter(([, r]) => r.name === q.get('name')).map(([id, r]) => ({ id, ...r })));
    if (/^\/zones\/[^/]+\/dns_records$/.test(p) && m === 'POST') {
      if (o.failDns) return { status: 400, body: { success: false, errors: [{ code: 81053, message: 'An A, AAAA, or CNAME record with that host already exists.' }] } };
      const id = `rec${++n}`;
      records.set(id, body as { name: string; content: string; proxied: boolean });
      return ok({ id });
    }
    if ((x = /^\/zones\/([^/]+)\/dns_records\/([^/]+)$/.exec(p)) && m === 'DELETE') return records.delete(x[2]!) ? ok({ id: x[2] }) : undefined;
    return undefined;
  });
  const route = s.server.listeners('request')[0] as (...a: unknown[]) => void;
  s.server.removeAllListeners('request');
  s.server.on('request', (req: { headers: Record<string, string | undefined> }, res: { writeHead(n: number, h: object): void; end(b: string): void }) => {
    if (req.headers.authorization !== `Bearer ${o.token}`) {
      s.calls.push({ line: 'refused', auth: req.headers.authorization, body: undefined });
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: 'Authentication error' }] }));
      return;
    }
    route(req, res);
  });
  return { url: s.url, calls: s.calls, hang: s.hang, tunnels, records, close: closer(s.server) };
}

export interface FakeNgrok extends Fake {
  credentials: Map<string, string>;
  domains: Map<string, string>;
  /** The metadata of each credential and domain made with one. */
  metadata: Map<string, string>;
}

/** ngrok: the API key `key` alone; `domains` the account has before (id → domain); `canReserve` false refuses a new one. */
export async function fakeNgrok(o: { key: string; domains?: Record<string, string>; canReserve?: boolean }): Promise<FakeNgrok> {
  const credentials: FakeNgrok['credentials'] = new Map();
  const domains: FakeNgrok['domains'] = new Map(Object.entries(o.domains ?? {}));
  const metadata: FakeNgrok['metadata'] = new Map();
  const tag = (id: string, b: unknown): void => { const m = (b as { metadata?: string }).metadata; if (m) metadata.set(id, m); };
  const meta = (id: string) => (metadata.has(id) ? { metadata: metadata.get(id) } : {});
  let n = 0;
  const s = await serve((m, path, body) => {
    let x: RegExpExecArray | null;
    if (path === '/credentials' && m === 'POST') {
      const id = `cr_${++n}`;
      const token = `2mint${n}${'a'.repeat(30)}`;
      credentials.set(id, token);
      tag(id, body);
      return { status: 201, body: { id, token } };
    }
    if (path === '/credentials' && m === 'GET') return { status: 200, body: { credentials: [...credentials.keys()].map((id) => ({ id, ...meta(id) })) } };
    if ((x = /^\/credentials\/([^/]+)$/.exec(path)) && m === 'DELETE') return credentials.delete(x[1]!) ? { status: 204, body: '' } : undefined;
    if (path === '/reserved_domains' && m === 'GET') return { status: 200, body: { reserved_domains: [...domains].map(([id, domain]) => ({ id, domain, ...meta(id) })) } };
    if (path === '/reserved_domains' && m === 'POST') {
      if (o.canReserve === false) return { status: 400, body: { error_code: 'ERR_NGROK_413', msg: 'Your account may not reserve domains.' } };
      const id = `rd_${++n}`;
      domains.set(id, (body as { domain: string }).domain);
      tag(id, body);
      return { status: 201, body: { id, domain: (body as { domain: string }).domain } };
    }
    if ((x = /^\/reserved_domains\/([^/]+)$/.exec(path)) && m === 'DELETE') return domains.delete(x[1]!) ? { status: 204, body: '' } : undefined;
    return undefined;
  });
  const route = s.server.listeners('request')[0] as (...a: unknown[]) => void;
  s.server.removeAllListeners('request');
  s.server.on('request', (req: { headers: Record<string, string | undefined> }, res: { writeHead(n: number, h: object): void; end(b: string): void }) => {
    if (req.headers.authorization !== `Bearer ${o.key}` || req.headers['ngrok-version'] !== '2') {
      s.calls.push({ line: 'refused', auth: req.headers.authorization, body: undefined });
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error_code: 'ERR_NGROK_401', msg: 'The API key is not valid.' }));
      return;
    }
    route(req, res);
  });
  return { url: s.url, calls: s.calls, hang: s.hang, credentials, domains, metadata, close: closer(s.server) };
}
