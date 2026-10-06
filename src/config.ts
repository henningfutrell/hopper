// Configuration from env: process settings only (docs/design.md "Settled in slice 4"); every part is
// configured in the plugins config, a config record in the store; secrets come from the runtime (design.md
// "Secrets", src/secrets/runtime.ts), read by the parts that use them — the database URL, which
// carries a password, among them. No default names a path on this machine. Invalid values fail loudly.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hopperApps, type HopperApps } from './connected-accounts/hopper-app.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { parseDatabaseUrl } from './store/db.ts';

export interface Config {
  /** The bind address: `127.0.0.1`, or `::` (every interface) when LAN names are set. */
  host: string;
  port: number;
  /** HOPPER_DATABASE_URL (or the file HOPPER_DATABASE_URL_FILE names): `postgres://…` (design.md "Database"). Required. */
  databaseUrl: string;
  /** Scratch only — claude's working directory, ssh control sockets, probes; nothing kept. */
  workDir: string;
  tickMs: number;
  softLimit: number;
  hardLimit: number;
  routerCheapBoost: number;
  webhookBaseMs: number;
  laneIdleGraceMs: number;
  /** The question service's ceiling per stage (answer, assess), whatever a plugin's own timeout says. */
  answerTimeoutMs: number;
  humanRenotifyMs: number;
  humanTimeoutMs: number;
  resumeBoost: number;
  maxQuestions: number;
  /** Keep panes open after a job ends (for inspection); default false: every terminal outcome cleans up. */
  keepPanes: boolean;
  /** This host is a machine: the built-in `local` instance runs jobs here. False in the container (issue #141). */
  localMachine: boolean;
  /** Lifetime of a UI session, in hours. */
  uiSessionHours: number;
  /** Custom plugins, one directory each; unset: none. */
  pluginDir?: string;
  /** The plugin store: a git repository holding plugin-store.yaml; unset: none (design.md "Plugin store"). */
  pluginStore?: string;
  /** The URL people reach the UI at through a reverse proxy (origin only), or undefined. The sign-in origin when set. */
  publicUrl: string | undefined;
  /** Host names the UI answers to on the LAN (lowercase, no port); empty: loopback only. */
  lanNames: string[];
  /** CIDR ranges a LAN request may come from. */
  lanPeers: string[];
  /** How often the self-update checks the update repository; 0: only when asked (design.md "Self-update"). */
  updateCheckMs: number;
  /** Forces how the daemon starts again after an update: `exit` (a supervisor restarts it) or `respawn`; absent: detected. */
  restart?: 'exit' | 'respawn';
  /**
   * Every set HOPPER_* variable this config does not read, raw: the part-choosing ones removed
   * in phase 5 slices 4 and 5 (read once more by the plugins config migration) and any unknown one. The
   * daemon warns about them at boot.
   */
  leftoverEnv: Record<string, string>;
  /** The hopper's app — its GitHub App — people sign in and connect through (issue #214): the shipped one unless the environment names another. */
  hopperApps: HopperApps;
}

const int = (min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max);
const fraction = () => z.coerce.number().min(0).max(1);
const flag = (fallback: boolean) => z.enum(['true', 'false']).default(fallback ? 'true' : 'false').transform((v) => v === 'true');
const list = (item: z.ZodType<string, string>) => z.string().default('')
  .transform((v) => v.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x !== ''))
  .pipe(z.array(item));
// A host name or IP literal, no port; never a loopback name (those are always served).
const lanName = z.string().regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/, 'must be host names or IPv4 addresses, comma-separated, no port')
  .refine((n) => n !== 'localhost' && !n.startsWith('127.'), 'loopback is always served; list LAN names only');
const lanPeer = z.union([z.cidrv4(), z.cidrv6()], { error: 'must be CIDR ranges, comma-separated (192.0.2.0/24)' });
// An origin only: http(s), no path, no query; never loopback (those are always served).
const publicUrl = z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' })
  .refine((u) => { const x = new URL(u); return (x.pathname === '/' || x.pathname === '') && x.search === '' && x.hash === ''; }, 'must be an origin only: scheme, host and port, no path')
  .refine((u) => !['localhost', '127.0.0.1', '[::1]'].includes(new URL(u).hostname), 'loopback is always served; name the public host')
  .transform((u) => new URL(u).origin);
const schema = z.object({
  HOPPER_PUBLIC_URL: publicUrl.optional(),
  // Loopback, plus the LAN names when set (AGENTS.md, design.md "Reaching the UI across the LAN").
  HOPPER_LAN_NAMES: list(lanName),
  HOPPER_LAN_PEERS: list(lanPeer),
  HOPPER_PORT: int(0, 65535).default(4790),
  HOPPER_DATABASE_URL: z.string({ error: 'required: postgres://user:password@host:port/database' })
    .superRefine((v, ctx) => { try { parseDatabaseUrl(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); } }),
  HOPPER_WORK_DIR: z.string().min(1).default(join(tmpdir(), 'hopper')),
  HOPPER_TICK_MS: int(1).default(2000),
  HOPPER_SOFT_LIMIT: fraction().default(0.7),
  HOPPER_HARD_LIMIT: fraction().default(0.95),
  HOPPER_ROUTER_CHEAP_BOOST: z.coerce.number().default(10),
  HOPPER_WEBHOOK_BASE_MS: int(1).default(1000),
  HOPPER_LANE_IDLE_GRACE_MS: int(0).default(5000),
  HOPPER_ANSWER_TIMEOUT_MS: int(1).default(180000),
  HOPPER_HUMAN_RENOTIFY_MS: int(1).default(900000),
  HOPPER_HUMAN_TIMEOUT_MS: int(1).default(86400000),
  HOPPER_RESUME_BOOST: z.coerce.number().finite().default(20),
  HOPPER_MAX_QUESTIONS: int(0).default(5),
  HOPPER_KEEP_PANES: flag(false),
  HOPPER_LOCAL_MACHINE: flag(true),
  HOPPER_UI_SESSION_HOURS: z.coerce.number().finite().positive().default(12),
  HOPPER_PLUGIN_DIR: z.string().min(1).optional(),
  HOPPER_PLUGIN_STORE: z.string().min(1).optional(),
  HOPPER_UPDATE_CHECK_MS: int(0).default(60000),
  HOPPER_RESTART: z.enum(['exit', 'respawn']).optional(),
  HOPPER_GITHUB_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  HOPPER_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  HOPPER_GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a GitHub App slug: lowercase letters, digits and dashes').optional(),
}).refine((e) => e.HOPPER_SOFT_LIMIT < e.HOPPER_HARD_LIMIT, {
  message: 'must be below HOPPER_HARD_LIMIT',
  path: ['HOPPER_SOFT_LIMIT'],
}).refine((e) => e.HOPPER_LAN_NAMES.length === 0 || e.HOPPER_LAN_PEERS.length > 0, {
  message: 'must be set with HOPPER_LAN_NAMES: the ranges LAN requests may come from',
  path: ['HOPPER_LAN_PEERS'],
}).refine((e) => e.HOPPER_LAN_PEERS.length === 0 || e.HOPPER_LAN_NAMES.length > 0 || e.HOPPER_PUBLIC_URL !== undefined, {
  message: 'must be set with HOPPER_LAN_PEERS (or set HOPPER_PUBLIC_URL): the names the UI answers to beyond loopback',
  path: ['HOPPER_LAN_NAMES'],
});

/** What each setting does, for `node src/main.ts --help`. Keyed by the schema: a new setting needs its line. */
const SETTING_HELP: Record<keyof typeof schema.shape, string> = {
  HOPPER_DATABASE_URL: 'the Postgres database that holds everything: postgres://user:password@host:port/database[?schema=<name>][&sslmode=require]. Or HOPPER_DATABASE_URL_FILE: a file holding it',
  HOPPER_PORT: 'the HTTP port of the UI, the API and the API reference',
  HOPPER_PUBLIC_URL: 'the origin people reach the UI at through a reverse proxy (https://hopper.example.com); a proxy on another host also needs HOPPER_LAN_PEERS',
  HOPPER_LAN_NAMES: 'host names the UI answers to on the LAN, comma-separated; needs HOPPER_LAN_PEERS. Unset: loopback only',
  HOPPER_LAN_PEERS: 'CIDR ranges LAN or proxy requests may come from, comma-separated (192.0.2.0/24); binds every interface',
  HOPPER_WORK_DIR: 'scratch space: working files, ssh control sockets. Nothing kept',
  HOPPER_PLUGIN_DIR: 'a directory of custom plugins, one directory each (docs/plugins.md). Unset: none',
  HOPPER_PLUGIN_STORE: 'the plugin store the UI installs plugins from (kept in the database, restored at start): a git repository (URL or path) holding plugin-store.yaml. Unset: none',
  HOPPER_TICK_MS: 'how often the engine decides',
  HOPPER_SOFT_LIMIT: 'usage fraction where a machine starts to close lanes',
  HOPPER_HARD_LIMIT: 'usage fraction where a machine starts nothing',
  HOPPER_ROUTER_CHEAP_BOOST: 'priority boost for a job the router calls cheap',
  HOPPER_WEBHOOK_BASE_MS: 'first webhook retry delay; doubles each retry',
  HOPPER_LANE_IDLE_GRACE_MS: 'how long an idle lane stays open',
  HOPPER_ANSWER_TIMEOUT_MS: 'ceiling per escalation level\'s call on a question',
  HOPPER_HUMAN_RENOTIFY_MS: 'how often an unanswered question is notified again',
  HOPPER_HUMAN_TIMEOUT_MS: 'when an unanswered question expires',
  HOPPER_RESUME_BOOST: 'priority boost for a job resumed after a question',
  HOPPER_MAX_QUESTIONS: 'questions one job may ask; the next one fails it',
  HOPPER_KEEP_PANES: 'true: keep a job\'s pane open after it ends, for inspection',
  HOPPER_LOCAL_MACHINE: 'false: this host is not a machine (the container): no `local` machine, and the boot removes one from the plugins config',
  HOPPER_UI_SESSION_HOURS: 'lifetime of a UI session',
  HOPPER_UPDATE_CHECK_MS: 'how often self-update checks for a newer version; 0: only when asked',
  HOPPER_RESTART: 'how the daemon starts again after an update: exit (a supervisor restarts it) or respawn. Unset: detected',
  HOPPER_GITHUB_URL: 'the GitHub people sign in with and connect (a GitHub Enterprise origin). Unset: https://github.com',
  HOPPER_GITHUB_CLIENT_ID: 'the client id of the GitHub App (device flow on) people sign in and connect through. Unset: the hopper\'s own',
  HOPPER_GITHUB_APP_SLUG: 'that GitHub App\'s slug, for its install link. Unset: the hopper\'s own',
};

/** Every setting the daemon reads: name, default (`required`, `unset` or the value), what it does. */
export const SETTINGS: { name: string; default: string; help: string }[] = Object.entries(SETTING_HELP).map(([name, help]) => {
  const field = schema.shape[name as keyof typeof schema.shape] as z.ZodType;
  const json = z.toJSONSchema(field, { io: 'input', unrepresentable: 'any' }) as { default?: unknown };
  const fallback = json.default !== undefined ? String(json.default) : field.safeParse(undefined).success ? 'unset' : 'required';
  return { name, default: fallback === '' ? 'unset' : fallback, help };
});

/** `node src/main.ts --help`: how to run the daemon and every setting it reads. */
export function daemonHelp(): string {
  const width = Math.max(...SETTINGS.map((s) => s.name.length));
  const lines = SETTINGS.map((s) => `  ${s.name.padEnd(width)}  ${s.help} [${s.default}]`);
  return `hopper daemon: pulls jobs from its job sources, runs them on its machines, serves the UI.

usage: node src/main.ts            (in the hopper directory; the container and the systemd unit run this)
       node src/main.ts --help

It is configured by environment variables; everything else is in its database and edited in the UI:
the plugins, the rules, sign-in and the webhook subscriptions. No config file.
Secrets come from the environment too: NAME, or NAME_FILE naming a file holding it (docs/deploy.md).

settings [default]:
${lines.join('\n')}

Sign-in set up at launch (each also NAME_FILE; written to the database at every start; docs/sign-in.md):
  HOPPER_SIGN_IN_REALM_<NAME>_TYPE        a realm: ldap, oidc, github, saml or gateway
  HOPPER_SIGN_IN_REALM_<NAME>_<SETTING>   its settings: ISSUER, CLIENT_ID, CLIENT_SECRET, ROLES_ADMIN_GROUPS, …
  HOPPER_SIGN_IN_LOCAL_ENABLED            the login code: true or false
  HOPPER_SIGN_IN_NONE_ROLE                no sign-in: viewer, operator, admin or off

Once it runs (default port 4790):
  UI              http://127.0.0.1:4790/        sign in with GitHub: the first person to do so is the admin
  API reference   http://127.0.0.1:4790/docs/
  operator CLI    hopper help

Read on: README.md, docs/deploy.md, docs/sign-in.md, docs/plugins.md.
`;
}

/** A secret among the settings: also read from a mounted file, `<name>_FILE`. */
const SECRET_SETTINGS = ['HOPPER_DATABASE_URL'];
/** Read by the parts, not here (design.md "Target authentication"): the hopper's ssh key and its docker socket. */
const PART_SETTINGS = ['HOPPER_SSH_KEY', 'HOPPER_SSH_KEY_FILE', 'HOPPER_DOCKER_HOST'];
const READ = new Set([...Object.keys(schema.shape), ...SECRET_SETTINGS.map((n) => `${n}_FILE`), ...PART_SETTINGS]);

/**
 * Reads only HOPPER_* keys; empty strings count as unset. Throws on any invalid value of a key
 * it reads; the rest go to `leftoverEnv` unvalidated.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const set = Object.entries(env).filter((e): e is [string, string] => e[0].startsWith('HOPPER_') && e[1] !== undefined && e[1] !== '');
  const relevant: Record<string, string | undefined> = Object.fromEntries(set.filter(([k]) => READ.has(k)));
  const secret = runtimeSecrets(relevant);
  try {
    for (const name of SECRET_SETTINGS) { relevant[name] = secret(name); delete relevant[`${name}_FILE`]; }
  } catch (e) {
    throw new Error(`invalid configuration: ${(e as Error).message}`, { cause: e });
  }
  // HOPPER_SIGN_IN_* set sign-in up; the daemon reads them at start (src/auth/environment.ts).
  const leftoverEnv = Object.fromEntries(set.filter(([k]) => !READ.has(k) && !k.startsWith('HOPPER_SIGN_IN_')));
  const parsed = schema.safeParse(relevant);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`invalid configuration: ${problems}`);
  }
  const e = parsed.data;
  return {
    // Every interface only when requests may come from beyond loopback (LAN peers); a reverse proxy on this host needs none.
    host: e.HOPPER_LAN_PEERS.length > 0 ? '::' : '127.0.0.1',
    port: e.HOPPER_PORT,
    databaseUrl: e.HOPPER_DATABASE_URL,
    workDir: e.HOPPER_WORK_DIR,
    tickMs: e.HOPPER_TICK_MS,
    softLimit: e.HOPPER_SOFT_LIMIT,
    hardLimit: e.HOPPER_HARD_LIMIT,
    routerCheapBoost: e.HOPPER_ROUTER_CHEAP_BOOST,
    webhookBaseMs: e.HOPPER_WEBHOOK_BASE_MS,
    laneIdleGraceMs: e.HOPPER_LANE_IDLE_GRACE_MS,
    answerTimeoutMs: e.HOPPER_ANSWER_TIMEOUT_MS,
    humanRenotifyMs: e.HOPPER_HUMAN_RENOTIFY_MS,
    humanTimeoutMs: e.HOPPER_HUMAN_TIMEOUT_MS,
    resumeBoost: e.HOPPER_RESUME_BOOST,
    maxQuestions: e.HOPPER_MAX_QUESTIONS,
    keepPanes: e.HOPPER_KEEP_PANES,
    localMachine: e.HOPPER_LOCAL_MACHINE,
    uiSessionHours: e.HOPPER_UI_SESSION_HOURS,
    ...(e.HOPPER_PLUGIN_DIR ? { pluginDir: e.HOPPER_PLUGIN_DIR } : {}),
    ...(e.HOPPER_PLUGIN_STORE ? { pluginStore: e.HOPPER_PLUGIN_STORE } : {}),
    publicUrl: e.HOPPER_PUBLIC_URL,
    lanNames: e.HOPPER_LAN_NAMES,
    lanPeers: e.HOPPER_LAN_PEERS,
    updateCheckMs: e.HOPPER_UPDATE_CHECK_MS,
    ...(e.HOPPER_RESTART ? { restart: e.HOPPER_RESTART } : {}),
    leftoverEnv,
    hopperApps: hopperApps({
      github: {
        ...(e.HOPPER_GITHUB_URL ? { url: e.HOPPER_GITHUB_URL } : {}), ...(e.HOPPER_GITHUB_CLIENT_ID ? { clientId: e.HOPPER_GITHUB_CLIENT_ID } : {}),
        ...(e.HOPPER_GITHUB_APP_SLUG ? { slug: e.HOPPER_GITHUB_APP_SLUG } : {}),
      }
    }),
  };
}
