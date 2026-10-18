// The socket guard (issue #1955): no connection and no name lookup leaves this machine in a test, whatever client makes
// it. Every TCP connection in Node goes through `net.Socket.prototype.connect` — `net.connect`, `tls.connect`, `http`,
// `https`, fetch (undici), so the AWS SDK, Octokit, the Kubernetes client, pg and ldapts too — so the guard is there: a
// connection to a host that is not allowed fails with a test isolation error before any lookup. DNS lookups and queries
// of a name that is not allowed fail as an unknown name does (ENOTFOUND), with the same words.
// Allowed: unix sockets; loopback (`localhost`, `*.localhost`, 127.0.0.0/8, ::1, the unspecified address); this
// machine's own name; and the host of every `HOPPER_TEST_*` URL — the test Postgres (and so the host testcontainers
// maps its containers to, or TESTCONTAINERS_HOST_OVERRIDE) and the opt-in real-service tests (`HOPPER_TEST_SOLR_URL`, `HOPPER_TEST_VAULT_ADDR`, ...).
// Loaded by test/support/isolate.ts in every worker, and by NODE_OPTIONS (`--import`) in every node process a test
// starts. Imports nothing of hopper.
import dns from 'node:dns';
import { isIP } from 'node:net';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { hostname } from 'node:os';

/** The code of the error a refused connection fails with. */
export const ISOLATION_CODE = 'ETESTISOLATION';

const INSTALLED = Symbol.for('hopper.test.networkGuard');

const bare = (host: string): string => host.replace(/^\[|\]$/g, '').toLowerCase();

/** The hosts of every `HOPPER_TEST_*` value that is a URL: the test services the tests may reach. */
export function testServiceHosts(env: NodeJS.ProcessEnv): string[] {
  const hosts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('HOPPER_TEST_') || !value) continue;
    try {
      const host = new URL(value).hostname;
      if (host) hosts.push(bare(host));
    } catch { /* not a URL: nothing to allow */ }
  }
  return hosts;
}

const loopbackAddress = (address: string): boolean => {
  const a = bare(address).replace(/^::ffff:/, '');
  if (isIP(a) === 4) return a.startsWith('127.') || a === '0.0.0.0';
  return a === '::1' || a === '::';
};

/** Whether a test may connect to, or look up, `host`. */
export function allowedHost(host: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const h = bare(host);
  if (h === '' || h === 'localhost' || h.endsWith('.localhost') || loopbackAddress(h)) return true;
  if (h === hostname().toLowerCase()) return true;
  if (env.TESTCONTAINERS_HOST_OVERRIDE && bare(env.TESTCONTAINERS_HOST_OVERRIDE) === h) return true;
  return testServiceHosts(env).includes(h);
}

const refusal = (what: string): Error =>
  Object.assign(new Error(`test isolation: refused ${what} off this machine; a test reaches only loopback, unix sockets and the HOPPER_TEST_* services`), { code: ISOLATION_CODE });

const lookupRefusal = (name: string): Error =>
  Object.assign(new Error(`test isolation: refused DNS lookup of ${name}: getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND', hostname: name });

type ConnectOptions = { path?: string | null; host?: string; port?: number | string; lookup?: (...a: never[]) => void };

/** The options of a `connect` call, in any of its forms: normalized args, an options object, a path, a port and host. */
function connectOptions(args: unknown[]): ConnectOptions {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object' && first !== null) return first as ConnectOptions;
  if (typeof first === 'string' && !/^\d+$/.test(first)) return { path: first };
  return { port: first as number, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
}

type Lookup = (host: string, options: unknown, callback: (err: Error | null, address: unknown, family?: number) => void) => void;

/** A connection's own lookup (a test's DNS double), checked on its answer: only allowed addresses go through. */
const checkedLookup = (lookup: Lookup): Lookup => (host, options, callback) => {
  lookup(host, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const addresses = Array.isArray(address) ? address.map((a: { address: string }) => a.address) : [String(address)];
    const off = addresses.find((a) => !allowedHost(a));
    if (off !== undefined) return callback(refusal(`connection to ${host} (${off})`), address, family);
    callback(null, address, family);
  });
};

function guardSockets(): void {
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    const o = connectOptions(args);
    if (typeof o.path === 'string') return connect.apply(this, args as never);
    const host = o.host ?? 'localhost';
    if (allowedHost(host)) return connect.apply(this, args as never);
    if (isIP(bare(host)) === 0 && typeof o.lookup === 'function' && o.lookup !== dns.lookup) {
      o.lookup = checkedLookup(o.lookup as Lookup) as never;
      return connect.apply(this, args as never);
    }
    const err = refusal(`connection to ${host}${o.port === undefined ? '' : `:${o.port}`}`);
    // As a real connect does: connecting at once, so a write waits, and failing after the caller's own listeners (http
    // hands a new socket to its request only on the next tick).
    (this as { connecting: boolean }).connecting = true;
    setImmediate(() => this.destroy(err));
    return this;
  } as typeof connect;
}

const RESOLVE = ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr',
  'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt', 'reverse'] as const;

/** Replaces `target[name]`, a callback DNS function, with one that refuses a name that is not allowed. */
function guardCallback(target: Record<string, unknown>, name: string): void {
  const real = target[name];
  if (typeof real !== 'function') return;
  target[name] = function guarded(this: unknown, query: string, ...rest: unknown[]) {
    if (typeof query === 'string' && !allowedHost(query)) {
      const callback = rest.at(-1);
      if (typeof callback === 'function') process.nextTick(() => callback(lookupRefusal(query)));
      return undefined;
    }
    return real.call(this, query, ...rest);
  };
}

/** Replaces `target[name]`, a promise DNS function, with one that rejects a name that is not allowed. */
function guardPromise(target: Record<string, unknown>, name: string): void {
  const real = target[name];
  if (typeof real !== 'function') return;
  target[name] = function guarded(this: unknown, query: string, ...rest: unknown[]) {
    if (typeof query === 'string' && !allowedHost(query)) return Promise.reject(lookupRefusal(query));
    return real.call(this, query, ...rest);
  };
}

function guardDns(): void {
  const callbacks = dns as unknown as Record<string, unknown>;
  const promises = dns.promises as unknown as Record<string, unknown>;
  for (const name of ['lookup', ...RESOLVE]) {
    guardCallback(callbacks, name);
    guardCallback(dns.Resolver.prototype as unknown as Record<string, unknown>, name);
    guardPromise(promises, name);
    guardPromise(dns.promises.Resolver.prototype as unknown as Record<string, unknown>, name);
  }
}

/** Installs the guard once per process; `import { connect } from 'node:net'` and the like see it too. */
export function installNetworkGuard(): void {
  const g = globalThis as Record<symbol, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;
  guardSockets();
  guardDns();
  syncBuiltinESMExports();
}

installNetworkGuard();
