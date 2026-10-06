// Signing in through the realms (design.md "Sign-in: realms"). The sign-in config as it applies now, swapped at
// once by `apply` when Settings → Sign-in changes it.
//
// Form realms (password, ldap): the username and password form is tried against each one that is on,
// in order; the first that accepts the password decides. A password realm with no account is not
// tried; one that is on with an admin account always exists (the password fallback, `fallback.ts`).
//
// Redirect realms (oidc, github, saml): three steps, no cookies (they ignore ports; see "UI session and
// mutations"):
//   1. begin: the browser keeps a random binding in localStorage and asks for /ui/auth/<name>/start;
//      a flow (the realm's secrets, the binding's hash) is kept here and the browser goes to the
//      identity provider.
//   2. callback: the identity provider sends the browser back; its answer becomes an Identity and a
//      role, held under a one-time ticket.
//   3. complete: the callback page posts the ticket with the binding from localStorage. Only the
//      browser that began the flow has it, so a callback link handed to someone else signs nobody in.
//
// Gateway realms (issue #215): an auth gateway in front of the hopper signed the person in and forwards
// their token; each gateway realm that is on checks it, in order, and the first that accepts it decides.
// Flows and tickets live in memory: a restart mid-sign-in means signing in again.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../domain/ports.ts';
import type { Identity, SignInRealmView, UiRole } from '../domain/types.ts';
import { isFormRealm, isGatewayRealm, isRedirectRealm, type AuthConfig, type RealmConfig } from './config.ts';
import { createGatewayRealm } from './gateway.ts';
import { createGithubRealm } from './github.ts';
import { createLdapRealm } from './ldap.ts';
import { createOidcRealm } from './oidc.ts';
import { createPasswordRealm, passwordRoleOf } from './password.ts';
import type { FlowSecrets, FormRealm, GatewayRealm, RealmCallback, RedirectRealm } from './realm.ts';
import { roleFor } from './roles.ts';
import { createSamlRealm } from './saml.ts';

export { SIGN_IN, loadSignInConfig, signInConfigProblem, type AuthConfig } from './config.ts';
export { accountOf, AuthEditError, editSignIn, realmsView, type SignInEdit } from './edit.ts';
export { hasPasswordFallback, withPasswordFallback } from './fallback.ts';
export { hashPassword } from './password.ts';

const FLOW_MS = 10 * 60_000;
const TICKET_MS = 2 * 60_000;
/**
 * Starting a flow needs no session, so the pending ones are capped. Past the cap the oldest is
 * evicted: a flood of starts costs a real user at most a retry, never a lockout (rate-limit
 * /ui/auth/ at the reverse proxy: docs/sign-in.md).
 */
const MAX_FLOWS = 10_000;
const BINDING = /^[A-Za-z0-9_-]{32,128}$/;

export const LOCAL_IDENTITY: Identity = { realm: 'local', subject: 'local', name: 'login code', groups: [] };
/** Who a no-sign-in session belongs to: nobody in particular. */
export const NO_SIGN_IN_IDENTITY: Identity = { realm: 'none', subject: 'anonymous', name: 'no sign-in', groups: [] };

export type CallbackOutcome =
  | { ok: true; ticket: string; who: Identity; role: UiRole }
  | { ok: false; status: 400 | 403 | 502; error: string; who?: Identity };

export type GatewayCheckOutcome =
  | { ok: true; who: Identity; role: UiRole }
  | { ok: false; status: 403 | 502; error: string; who?: Identity };

export type PasswordOutcome =
  | { ok: true; who: Identity; role: UiRole }
  | { ok: false; status: 403 | 502; error: string; who?: Identity };

export interface SignIn {
  /** The one-time login code works. */
  readonly local: boolean;
  /** No sign-in: the role everyone gets; null when off. */
  readonly none: UiRole | null;
  /** Password sign-in is on: an LDAP realm is, or a password realm with an account. */
  readonly password: boolean;
  /** The username and password tried against the form realms that are on, in order. */
  checkPassword(username: string, password: string): Promise<PasswordOutcome>;
  /** A gateway realm is on. */
  readonly gateway: boolean;
  /** The token an auth gateway forwarded on this request, checked by the gateway realms that are on, in order. */
  checkGateway(headers: Record<string, string | string[] | undefined>): Promise<GatewayCheckOutcome>;
  /** Where an OIDC, GitHub or SAML sign-in starts and ends (known once the daemon listens). */
  origin(): string;
  /** The OIDC, GitHub and SAML realms that are on, in order. */
  realms(): SignInRealmView[];
  redirectRealm(name: string): RedirectRealm | undefined;
  /** The identity provider URL to send the browser to. Throws SignInRefused. */
  begin(name: string, binding: string): Promise<string>;
  callback(name: string, cb: RealmCallback): Promise<CallbackOutcome>;
  /** The identity and role behind a ticket, once, for the browser holding the binding. */
  complete(ticket: string, binding: string): { who: Identity; role: UiRole } | undefined;
  /** The role the sign-in config grants this identity now; null: none, or its realm is gone or off. */
  roleOf(who: Identity): UiRole | null;
  /** The sign-in config as it applies now. */
  config(): AuthConfig;
  /** Apply a changed sign-in config at once: the realms, local sign-in and no sign-in. Flows in progress stay. */
  apply(config: AuthConfig): void;
}

export class SignInRefused extends Error {
  readonly status: 400 | 404;
  constructor(status: 400 | 404, message: string) { super(message); this.status = status; }
}

interface Flow { realm: string; binding: string; secrets: FlowSecrets; expires: number }
interface Ticket { who: Identity; role: UiRole; binding: string; expires: number }

const hash = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();
const random = (): string => randomBytes(32).toString('hex');

/** The role `config` grants `who`; null: none, or its realm is gone or off. */
export function roleIn(config: AuthConfig, who: Identity): UiRole | null {
  if (who.realm === 'local') return config.local.enabled ? 'admin' : null;
  if (who.realm === 'none') return config.none?.role ?? null;
  const r = config.realms.find((x) => x.name === who.realm);
  if (!r?.enabled) return null;
  return r.type === 'password' ? passwordRoleOf(r, who.subject) : roleFor(who, r.roles);
}

function buildRedirect(r: Extract<RealmConfig, { type: 'oidc' | 'github' | 'saml' }>, origin: string): RedirectRealm {
  const callback = `${origin}/ui/auth/${r.name}/callback`;
  if (r.type === 'oidc') return createOidcRealm(r, callback);
  if (r.type === 'github') return createGithubRealm(r, callback);
  return createSamlRealm(r, callback, r.entityId ?? `${origin}/ui/auth/${r.name}/metadata`);
}

const buildForm = (r: Extract<RealmConfig, { type: 'password' | 'ldap' }>): FormRealm => (r.type === 'password' ? createPasswordRealm(r) : createLdapRealm(r));

export function createSignIn(o: { config: AuthConfig; origin: () => string; clock: Clock; maxFlows?: number }): SignIn {
  const maxFlows = o.maxFlows ?? MAX_FLOWS;
  let config = o.config;
  let forms: FormRealm[] = [];
  let gateways: GatewayRealm[] = [];
  // Built on first use: the redirect URIs need the bound port.
  let redirects: Map<string, RedirectRealm> | undefined;
  const on = (): RealmConfig[] => config.realms.filter((r) => r.enabled);
  const build = (): void => {
    forms = on().filter(isFormRealm).filter((r) => r.type !== 'password' || r.users.length > 0).map(buildForm);
    gateways = on().filter(isGatewayRealm).map(createGatewayRealm);
    redirects = undefined;
  };
  build();
  const redirect = (): Map<string, RedirectRealm> =>
    (redirects ??= new Map(on().filter(isRedirectRealm).map((r) => [r.name, buildRedirect(r, o.origin())] as const)));
  const flows = new Map<string, Flow>();
  const tickets = new Map<string, Ticket>();
  const now = (): number => o.clock.now().getTime();
  const prune = (): void => {
    for (const [k, f] of flows) if (f.expires <= now()) flows.delete(k);
    for (const [k, t] of tickets) if (t.expires <= now()) tickets.delete(k);
  };
  const roleOf = (who: Identity): UiRole | null => roleIn(config, who);

  return {
    get local() { return config.local.enabled; },
    get none() { return config.none?.role ?? null; },
    get password() { return forms.length > 0; },
    async checkPassword(username, password) {
      const errors: string[] = [];
      for (const realm of forms) {
        const r = await realm.check(username, password);
        if (r.ok) {
          // The first realm that accepts the password decides, even when it grants no role.
          return r.role === null ? { ok: false, status: 403, error: 'signed in, but the sign-in config grants this account no role', who: r.who } : { ok: true, who: r.who, role: r.role };
        }
        if ('error' in r) errors.push(r.error);
      }
      return errors.length ? { ok: false, status: 502, error: `sign-in could not be checked: ${errors.join('; ')}` } : { ok: false, status: 403, error: 'wrong username or password' };
    },
    get gateway() { return gateways.length > 0; },
    async checkGateway(headers) {
      const refusals: string[] = [];
      const errors: string[] = [];
      for (const realm of gateways) {
        const r = await realm.check(headers);
        if (r.ok) {
          // The first realm that accepts the token decides, even when it grants no role.
          const role = roleOf(r.who);
          return role === null ? { ok: false, status: 403, error: 'signed in at the gateway, but the sign-in config grants this account no role', who: r.who } : { ok: true, who: r.who, role };
        }
        if ('error' in r) errors.push(`${realm.label}: ${r.error}`); else refusals.push(`${realm.label}: ${r.refused}`);
      }
      return errors.length ? { ok: false, status: 502, error: `the gateway's token could not be checked: ${errors.join('; ')}` } : { ok: false, status: 403, error: refusals.join('; ') || 'no gateway realm is on' };
    },
    origin: o.origin,
    realms: () => on().filter(isRedirectRealm).map((r) => ({ name: r.name, label: r.label, type: r.type })),
    redirectRealm: (name) => redirect().get(name),
    roleOf,
    config: () => config,
    apply(next) {
      config = next;
      build();
    },
    async begin(name, binding) {
      const r = redirect().get(name);
      if (!r) throw new SignInRefused(404, `no realm ${name} to sign in with`);
      if (!BINDING.test(binding)) throw new SignInRefused(400, 'missing or malformed binding');
      prune();
      // A Map iterates in insertion order: the first key is the oldest flow.
      while (flows.size >= maxFlows) flows.delete(flows.keys().next().value!);
      const id = random();
      const { url, secrets } = await r.start(id);
      flows.set(id, { realm: name, binding: hash(binding).toString('hex'), secrets, expires: now() + FLOW_MS });
      return url;
    },
    async callback(name, cb) {
      const r = redirect().get(name);
      if (!r) return { ok: false, status: 400, error: `no realm ${name} to sign in with` };
      prune();
      const id = r.flowIdOf(cb);
      const flow = id === undefined ? undefined : flows.get(id);
      if (!flow || flow.realm !== name) return { ok: false, status: 400, error: 'unknown or expired sign-in; start again' };
      flows.delete(id!);
      let who: Identity;
      try {
        who = await r.finish(cb, flow.secrets);
      } catch (e) {
        return { ok: false, status: 502, error: `${r.label} sign-in failed: ${(e as Error).message}` };
      }
      const role = roleOf(who);
      if (role === null) return { ok: false, status: 403, error: 'signed in, but the sign-in config grants this account no role', who };
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
