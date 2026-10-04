// Signing in through an identity provider (design.md "Sign-in: local, OIDC and SAML"). Three steps,
// no cookies (they ignore ports; see "UI session and mutations"):
//   1. begin: the browser keeps a random binding in localStorage and asks for /ui/auth/<name>/start;
//      a flow (provider secrets, the binding's hash) is kept here and the browser goes to the provider.
//   2. callback: the provider sends the browser back; its answer becomes an Identity and a role,
//      held under a one-time ticket.
//   3. complete: the callback page posts the ticket with the binding from localStorage. Only the
//      browser that began the flow has it, so a callback link handed to someone else signs nobody in.
// Flows and tickets live in memory: a restart mid-sign-in means signing in again.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../domain/ports.ts';
import type { Identity, SignInProviderView, UiRole } from '../domain/types.ts';
import type { AuthConfig, ProviderConfig } from './config.ts';
import { createGithubProvider } from './github.ts';
import { createOidcProvider } from './oidc.ts';
import type { FlowSecrets, IdentityProvider, ProviderCallback } from './provider.ts';
import { roleFor } from './roles.ts';
import { createSamlProvider } from './saml.ts';

export { DEFAULT_AUTH_FILE, loadAuthFile, type AuthConfig } from './config.ts';

const FLOW_MS = 10 * 60_000;
const TICKET_MS = 2 * 60_000;
/**
 * Starting a flow needs no session, so the pending ones are capped. Past the cap the oldest is
 * evicted: a flood of starts costs a real user at most a retry, never a lockout (rate-limit
 * /ui/auth/ at the reverse proxy: docs/sign-in.md).
 */
const MAX_FLOWS = 10_000;
const BINDING = /^[A-Za-z0-9_-]{32,128}$/;

export const LOCAL_IDENTITY: Identity = { provider: 'local', subject: 'local', name: 'login code', groups: [] };

export type CallbackOutcome =
  | { ok: true; ticket: string; who: Identity; role: UiRole }
  | { ok: false; status: 400 | 403 | 502; error: string; who?: Identity };

export interface SignIn {
  /** The one-time login code works. */
  readonly local: boolean;
  /** Where provider sign-in starts and ends (known once the daemon listens). */
  origin(): string;
  providers(): SignInProviderView[];
  provider(name: string): IdentityProvider | undefined;
  /** The provider URL to send the browser to. Throws SignInRefused. */
  begin(name: string, binding: string): Promise<string>;
  callback(name: string, cb: ProviderCallback): Promise<CallbackOutcome>;
  /** The identity and role behind a ticket, once, for the browser holding the binding. */
  complete(ticket: string, binding: string): { who: Identity; role: UiRole } | undefined;
  /** The role auth.yaml grants this identity now; null: none, or its provider is gone. */
  roleOf(who: Identity): UiRole | null;
}

export class SignInRefused extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

interface Flow { provider: string; binding: string; secrets: FlowSecrets; expires: number }
interface Ticket { who: Identity; role: UiRole; binding: string; expires: number }

const hash = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const random = (): string => randomBytes(32).toString('hex');

function build(p: ProviderConfig, origin: string): IdentityProvider {
  const callback = `${origin}/ui/auth/${p.name}/callback`;
  if (p.type === 'oidc') return createOidcProvider(p, callback);
  if (p.type === 'github') return createGithubProvider(p, callback);
  return createSamlProvider(p, callback, p.entityId ?? `${origin}/ui/auth/${p.name}/metadata`);
}

export function createSignIn(o: { config: AuthConfig; origin: () => string; clock: Clock; maxFlows?: number }): SignIn {
  const maxFlows = o.maxFlows ?? MAX_FLOWS;
  const configs = new Map(o.config.providers.map((p) => [p.name, p]));
  // Built on first use: the redirect URIs need the bound port.
  let providers: Map<string, IdentityProvider> | undefined;
  const built = (): Map<string, IdentityProvider> => (providers ??= new Map(o.config.providers.map((p) => [p.name, build(p, o.origin())])));
  const flows = new Map<string, Flow>();
  const tickets = new Map<string, Ticket>();
  const now = (): number => o.clock.now().getTime();
  const prune = (): void => {
    for (const [k, f] of flows) if (f.expires <= now()) flows.delete(k);
    for (const [k, t] of tickets) if (t.expires <= now()) tickets.delete(k);
  };
  const roleOf = (who: Identity): UiRole | null => {
    if (who.provider === 'local') return o.config.local.enabled ? 'admin' : null;
    const c = configs.get(who.provider);
    return c ? roleFor(who, c.roles) : null;
  };

  return {
    local: o.config.local.enabled,
    origin: o.origin,
    providers: () => o.config.providers.map((p) => ({ name: p.name, label: p.label, type: p.type })),
    provider: (name) => built().get(name),
    roleOf,
    async begin(name, binding) {
      const p = built().get(name);
      if (!p) throw new SignInRefused(404, `no identity provider ${name}`);
      if (!BINDING.test(binding)) throw new SignInRefused(400, 'missing or malformed binding');
      prune();
      // A Map iterates in insertion order: the first key is the oldest flow.
      while (flows.size >= maxFlows) flows.delete(flows.keys().next().value!);
      const id = random();
      const { url, secrets } = await p.start(id);
      flows.set(id, { provider: name, binding: hash(binding).toString('hex'), secrets, expires: now() + FLOW_MS });
      return url;
    },
    async callback(name, cb) {
      const p = built().get(name);
      if (!p) return { ok: false, status: 400, error: `no identity provider ${name}` };
      prune();
      const id = p.flowIdOf(cb);
      const flow = id === undefined ? undefined : flows.get(id);
      if (!flow || flow.provider !== name) return { ok: false, status: 400, error: 'unknown or expired sign-in; start again' };
      flows.delete(id!);
      let who: Identity;
      try {
        who = await p.finish(cb, flow.secrets);
      } catch (e) {
        return { ok: false, status: 502, error: `${p.label} sign-in failed: ${(e as Error).message}` };
      }
      const role = roleOf(who);
      if (role === null) return { ok: false, status: 403, error: 'signed in, but auth.yaml grants this account no role', who };
      const ticket = random();
      tickets.set(ticket, { who, role, binding: flow.binding, expires: now() + TICKET_MS });
      return { ok: true, ticket, who, role };
    },
    complete(ticket, binding) {
      prune();
      const t = tickets.get(ticket);
      if (!t || !BINDING.test(binding) || !timingSafeEqual(hash(binding), Buffer.from(t.binding, 'hex'))) return undefined;
      tickets.delete(ticket);
      return { who: t.who, role: t.role };
    },
  };
}
