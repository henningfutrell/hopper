// Configuration from env: process settings only (docs/design.md "Settled in slice 4"); every part is
// configured in the plugins config, a config record in the store; secrets come from the runtime (design.md
// "Secrets", src/secrets/runtime.ts), read by the parts that use them — the database URL, which
// carries a password, among them. No default names a path on this machine. Invalid values fail loudly.
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { hopperApps, type HopperApps } from './connected-accounts/hopper-app.ts';
import type { UsagePacing } from './domain/types.ts';
import { playgroundLimitsProblem } from './sandbox/playground.ts';
import { egressProblem, SANDBOX_SETTING_HELP, SANDBOX_SETTINGS, sandboxSettings, type SandboxSettings } from './sandbox/settings.ts';
import { MASTER_KEY_VARIABLES } from './secrets/master-key.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { parseDatabaseUrl } from './store/db.ts';
import { AWS_REGION_PATTERN, DEFAULT_KMS_KEY, type KmsSettings } from './vault/wire.ts';

export interface Config extends SandboxSettings {
  /** The bind address: `127.0.0.1`, or `::` (every interface) when LAN names are set. */
  host: string;
  port: number;
  /** HOPPER_HEALTH_PORT (issue #1383): the health port, on 127.0.0.1, answered off the event loop; absent: none. */
  healthPort?: number;
  /** HOPPER_DATABASE_URL (or the file HOPPER_DATABASE_URL_FILE names): `postgres://…` (design.md "Database"). Required. */
  databaseUrl: string;
  /** Scratch only — claude's working directory, ssh control sockets, probes; nothing kept. */
  workDir: string;
  tickMs: number;
  softLimit: number;
  hardLimit: number;
  /** Usage pacing (issue #373): HOPPER_BURN_WINDOW_HOURS, HOPPER_RESET_AWARE_PLACEMENT, HOPPER_CRITICAL_PRIORITY. */
  pacing: UsagePacing;
  routerCheapBoost: number;
  webhookBaseMs: number;
  laneIdleGraceMs: number;
  /** How long restart recovery waits for a running job's machine to answer before failing the job (issue #368). */
  reconnectGraceMs: number;
  /** How long a running job is held once its machine's link drops, before it fails (issue #752). */
  linkGraceMs: number;
  /** How long a done job its source finds not done waits before it is asked again (issue #637). */
  doneRecheckMs: number; doneReadRetryMs: number;
  /** How long the assessor waits between looks at a job's own pull request's checks while they run (issue #1230). */
  checksWaitMs: number;
  /** How long a job waiting on its own command shows no background work before its nudge, then before it is stuck (issue #1037). */
  ownCommandGraceMs: number;
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
  /** Custom plugins, one directory each; unset: none. */
  pluginDir?: string;
  /** Seeds the plugin store setting while it was never set (issue #445, design.md "Plugin store"). */
  pluginStore?: string;
  /** The URL people reach the UI at through a reverse proxy (origin only), or undefined. The sign-in origin when set. */
  publicUrl: string | undefined;
  /**
   * Each tunnel agent's local API, asked whether the remote access URL is up: HOPPER_TUNNEL_API (issue #795), ngrok's;
   * HOPPER_CLOUDFLARED_API (issue #968), cloudflared's metrics server. Neither set: no tunnel agent is asked.
   */
  tunnelApis: { ngrok?: string; cloudflare?: string };
  /** Host names the UI answers to on the LAN (lowercase, no port); empty: loopback only. */
  lanNames: string[];
  /** CIDR ranges a LAN request may come from. */
  lanPeers: string[];
  /** How often the self-update checks the update repository; not positive: every minute, never off (design.md "Self-update"). */
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
  /** The OpenFGA server access asks before every mint (issue #559), or undefined: none, and every mint is denied. */
  openFgaUrl?: string;
  /** The Solr core search reads and writes (issue #945): HOPPER_SOLR_URL. Absent: no search. */
  solrUrl?: string;
  /** The vault in a container of its own (issue #586); unset: the vault runs in the hopper. */
  vaultUrl?: string;
  /** The KMS the vault's data key is wrapped by (issues #586, #1288); unset: the vault seals under the master key. */
  kms?: KmsSettings;
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
  HOPPER_TUNNEL_API: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL (http://tunnel:4040)' }).optional(),
  HOPPER_CLOUDFLARED_API: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL (http://cloudflared:2000)' }).optional(),
  // Loopback, plus the LAN names when set (AGENTS.md, design.md "Reaching the UI across the LAN").
  HOPPER_LAN_NAMES: list(lanName),
  HOPPER_LAN_PEERS: list(lanPeer),
  HOPPER_PORT: int(0, 65535).default(4790),
  HOPPER_HEALTH_PORT: int(1, 65535).optional(),
  HOPPER_DATABASE_URL: z.string({ error: 'required: postgres://user:password@host:port/database' })
    .superRefine((v, ctx) => { try { parseDatabaseUrl(v); } catch (e) { ctx.addIssue({ code: 'custom', message: (e as Error).message }); } }),
  HOPPER_WORK_DIR: z.string().min(1).default(join(tmpdir(), 'hopper')),
  HOPPER_TICK_MS: int(1).default(2000),
  HOPPER_SOFT_LIMIT: fraction().default(0.7),
  HOPPER_HARD_LIMIT: fraction().default(0.95),
  HOPPER_BURN_WINDOW_HOURS: z.coerce.number().finite().min(0).default(18),
  HOPPER_RESET_AWARE_PLACEMENT: flag(true),
  HOPPER_CRITICAL_PRIORITY: int(0, 100).default(100),
  HOPPER_ROUTER_CHEAP_BOOST: z.coerce.number().default(10),
  HOPPER_WEBHOOK_BASE_MS: int(1).default(1000),
  HOPPER_LANE_IDLE_GRACE_MS: int(0).default(5000),
  HOPPER_RECONNECT_GRACE_MS: int(0).default(120000),
  HOPPER_LINK_GRACE_MS: int(0).default(600000),
  HOPPER_DONE_RECHECK_MS: int(0).default(60000),
  HOPPER_DONE_READ_RETRY_MS: int(0).default(5000),
  HOPPER_CHECKS_WAIT_MS: int(1).default(60000),
  HOPPER_OWN_COMMAND_GRACE_MS: int(0).default(300000),
  HOPPER_ANSWER_TIMEOUT_MS: int(1).default(180000),
  HOPPER_HUMAN_RENOTIFY_MS: int(1).default(900000),
  HOPPER_HUMAN_TIMEOUT_MS: int(1).default(86400000),
  HOPPER_RESUME_BOOST: z.coerce.number().finite().default(20),
  HOPPER_MAX_QUESTIONS: int(0).default(5),
  HOPPER_KEEP_PANES: flag(false),
  HOPPER_LOCAL_MACHINE: flag(true),
  HOPPER_PLUGIN_DIR: z.string().min(1).optional(),
  HOPPER_PLUGIN_STORE: z.string().min(1).optional(),
  HOPPER_UPDATE_CHECK_MS: int(0).default(60000),
  HOPPER_RESTART: z.enum(['exit', 'respawn']).optional(),
  HOPPER_GITHUB_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  HOPPER_GITHUB_CLIENT_ID: z.string().min(1).optional(),
  HOPPER_GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'a GitHub App slug: lowercase letters, digits and dashes').optional(),
  HOPPER_OPENFGA_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  HOPPER_SOLR_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL: the Solr core, http://solr:8983/solr/hopper' }).optional(),
  HOPPER_VAULT_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  HOPPER_KMS_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL' }).optional(),
  HOPPER_KMS_KEY: z.string().min(1).max(256).default(DEFAULT_KMS_KEY),
  HOPPER_KMS_REGION: z.string().regex(AWS_REGION_PATTERN, 'must be an AWS region, as eu-west-1').optional(),
  ...SANDBOX_SETTINGS,
}).refine((e) => e.HOPPER_SOFT_LIMIT < e.HOPPER_HARD_LIMIT, {
  message: 'must be below HOPPER_HARD_LIMIT',
  path: ['HOPPER_SOFT_LIMIT'],
}).refine((e) => e.HOPPER_LAN_NAMES.length === 0 || e.HOPPER_LAN_PEERS.length > 0, {
  message: 'must be set with HOPPER_LAN_NAMES: the ranges LAN requests may come from',
  path: ['HOPPER_LAN_PEERS'],
}).refine((e) => e.HOPPER_LAN_PEERS.length === 0 || e.HOPPER_LAN_NAMES.length > 0 || e.HOPPER_PUBLIC_URL !== undefined, {
  message: 'must be set with HOPPER_LAN_PEERS (or set HOPPER_PUBLIC_URL): the names the UI answers to beyond loopback',
  path: ['HOPPER_LAN_NAMES'],
}).superRefine((e, ctx) => {
  // The playground's defaults (issue #1410) are within its maximums: a create that names nothing is never refused.
  const problem = playgroundLimitsProblem(sandboxSettings(e).playground);
  if (problem) ctx.addIssue({ code: 'custom', message: problem, path: ['HOPPER_SANDBOX_MAX_CPUS'] });
  // A read-only box's egress (issue #849): its network, its proxy and the shared directory together, or none.
  const egress = egressProblem(e);
  if (egress) ctx.addIssue({ code: 'custom', message: egress, path: ['HOPPER_SANDBOX_EGRESS_NETWORK'] });
});

/** What each setting does, for `node src/main.ts --help`. Keyed by the schema: a new setting needs its line. */
const SETTING_HELP: Record<keyof typeof schema.shape, string> = {
  HOPPER_DATABASE_URL: 'the Postgres database that holds everything: postgres://user:password@host:port/database[?schema=<name>][&sslmode=require]. Or HOPPER_DATABASE_URL_FILE: a file holding it',
  HOPPER_PORT: 'the HTTP port of the UI, the API and the API reference',
  HOPPER_HEALTH_PORT: 'the health port: GET /api/health on 127.0.0.1 at this port, answered by a thread of its own, so it answers while the event loop is held too (503 and how long). Unset: none',
  HOPPER_PUBLIC_URL: 'the origin people reach the UI at through a reverse proxy (https://hopper.example.com); a proxy on another host also needs HOPPER_LAN_PEERS',
  HOPPER_TUNNEL_API: 'the local API of the ngrok agent (http://tunnel:4040, the compose service `tunnel`), asked whether the remote access URL is up while remote access is on with ngrok (Settings → Remote access); a Grok Bot routine is told where the hopper is reached. Unset: the hopper asks no ngrok agent',
  HOPPER_CLOUDFLARED_API: 'the metrics server of the cloudflared agent (http://cloudflared:2000, the compose service `cloudflared`), asked whether the tunnel is ready while remote access is on with Cloudflare Tunnel (Settings → Remote access). Unset: the hopper asks no cloudflared agent',
  HOPPER_LAN_NAMES: 'host names the UI answers to on the LAN, comma-separated; needs HOPPER_LAN_PEERS. Unset: loopback only',
  HOPPER_LAN_PEERS: 'CIDR ranges LAN or proxy requests may come from, comma-separated (192.0.2.0/24); binds every interface',
  HOPPER_WORK_DIR: 'scratch space: working files, ssh control sockets. Nothing kept',
  HOPPER_PLUGIN_DIR: 'a directory of custom plugins, one directory each (docs/plugins.md). Unset: none',
  HOPPER_PLUGIN_STORE: 'copied once into the plugin store setting (a git repository, URL or path, holding plugin-store.yaml) when that was never set; after that the plugin store is set in the UI (Plugins → Plugin store). Unset: the default plugin store',
  HOPPER_TICK_MS: 'how often the engine decides',
  HOPPER_SOFT_LIMIT: 'usage fraction where a machine starts to close lanes',
  HOPPER_HARD_LIMIT: 'usage fraction where a machine starts nothing',
  HOPPER_BURN_WINDOW_HOURS: 'hours before a week usage window resets in which it stops throttling unless it is spent, so what is left is used; 0: off',
  HOPPER_RESET_AWARE_PLACEMENT: 'true: a job goes to the machine whose account has the most week headroom per hour left before its reset; false: the most free lanes',
  HOPPER_CRITICAL_PRIORITY: 'a job at or above this priority that fits on no machine may run one lane over the cap; 0: off',
  HOPPER_ROUTER_CHEAP_BOOST: 'priority boost for a job the router calls cheap',
  HOPPER_WEBHOOK_BASE_MS: 'first webhook retry delay; doubles each retry',
  HOPPER_LANE_IDLE_GRACE_MS: 'how long an idle lane stays open',
  HOPPER_RECONNECT_GRACE_MS: 'after a restart, how long a running job waits for its machine to answer (a client to dial in, an ssh target to reply) before it fails',
  HOPPER_LINK_GRACE_MS: 'once a running job\'s machine link drops, how long the job is held on its lane for the link to come back before it fails',
  HOPPER_DONE_RECHECK_MS: 'a job that ended done whose source finds it not done is asked again after this long (GitHub may not show a new pull request at once) before it fails; 0: at once',
  HOPPER_DONE_READ_RETRY_MS: 'a job that ended done whose source cannot be read to check its work (a connect timeout, a busy service, a rate limit) is read again after this long, then after twice as long, before it fails; 0: at once',
  HOPPER_CHECKS_WAIT_MS: 'a job whose own pull request\'s checks were red (Own PR checks red): how long the hopper waits between looks at those checks while they run again, before it sends the job back to fix them',
  HOPPER_OWN_COMMAND_GRACE_MS: 'a job waiting on its own background command whose pane shows no background work for this long, its agent not gone on, is nudged once; this long after the nudge it is flagged stuck',
  HOPPER_ANSWER_TIMEOUT_MS: 'ceiling per escalation level\'s call on a question',
  HOPPER_HUMAN_RENOTIFY_MS: 'how often an unanswered question is notified again',
  HOPPER_HUMAN_TIMEOUT_MS: 'when an unanswered question expires',
  HOPPER_RESUME_BOOST: 'priority boost for a job resumed after a question',
  HOPPER_MAX_QUESTIONS: 'questions one job may ask; the next one fails it',
  HOPPER_KEEP_PANES: 'true: keep a job\'s pane open after it ends, for inspection',
  HOPPER_LOCAL_MACHINE: 'false: this host is not a machine (the container): the boot removes a `local` machine from the plugins config. A fresh plugins config lists none either way',
  HOPPER_UPDATE_CHECK_MS: 'how often self-update checks for a newer version; 0: the default, every minute (checks cannot be turned off)',
  HOPPER_RESTART: 'how the daemon starts again after an update: exit (a supervisor restarts it) or respawn. Unset: detected',
  HOPPER_GITHUB_URL: 'the GitHub people sign in with and connect (a GitHub Enterprise origin). Unset: https://github.com',
  HOPPER_GITHUB_CLIENT_ID: 'the client id of the GitHub App (device flow on) people sign in and connect through. Unset: the hopper\'s own',
  HOPPER_GITHUB_APP_SLUG: 'that GitHub App\'s slug, for its install link. Unset: the hopper\'s own',
  HOPPER_OPENFGA_URL: 'the OpenFGA server asked before every credential a job is given (http://openfga:8080); its preshared key HOPPER_OPENFGA_KEY. Unset: every credential is denied',
  HOPPER_SOLR_URL: 'the Solr core search keeps its index in (http://solr:8983/solr/hopper, the compose service `solr`). Unset: no search',
  HOPPER_VAULT_URL: 'the vault in a container of its own (http://hopper-vault:4791, the compose profile `hopper-vault`), reached with its preshared key HOPPER_VAULT_KEY. Unset: the vault runs in the hopper',
  HOPPER_KMS_URL: 'a local KMS the vault\'s data key is wrapped by (http://kms:8080, the compose profile `kms`), read where the vault runs. Unset: the vault seals under HOPPER_MASTER_KEY',
  HOPPER_KMS_KEY: 'the KMS key, by id, ARN or alias, that wraps the vault\'s data key; an alias a local KMS lacks is made, never one in AWS',
  HOPPER_KMS_REGION: 'AWS KMS in this region wraps the vault\'s data key, with the AWS credentials of where the vault runs (an EKS service account\'s role); HOPPER_KMS_URL is then its endpoint, if set. Unset: HOPPER_KMS_URL names a local KMS',
  ...SANDBOX_SETTING_HELP,
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
  HOPPER_GITHUB_CLIENT_SECRET             the GitHub App's client secret: Sign in with GitHub goes to GitHub and
                                          back in the browser on the sign-in origin. Unset: the device code only
  HOPPER_MASTER_KEY                       the master key every secret the hopper keeps is sealed under in the database
                                          (32 bytes, openssl rand -hex 32), given at launch or as the file _FILE names
                                          (a mounted Secret; one named but not there stops the start). Unset: made and
                                          shown once on a fresh database; on one that keeps secrets, no start
  HOPPER_MASTER_KEY_SEALED                set by master-key.sh run: the host sealed the key, and only it rotates it
  HOPPER_MASTER_KEY_PREVIOUS              older keys, one per line (also _FILE): they still open what they sealed,
                                          and what they sealed is sealed again under HOPPER_MASTER_KEY at start
  HOPPER_TOKEN_KEY                        the old token key (also _FILE: the compose secrets volume's token_key): read
                                          only while HOPPER_MASTER_KEY is unset, to move an install to it
  HOPPER_OPENFGA_KEY                      the preshared key of the OpenFGA server HOPPER_OPENFGA_URL names, read at
                                          each call. Unset: none sent
  HOPPER_VAULT_KEY                        the preshared key of the vault container HOPPER_VAULT_URL names, read at
                                          each call. Unset: the vault container is not asked
  HOPPER_TUNNEL_KEY                       the preshared key the tunnel service asks for its settings with (the compose
                                          stack makes it at each start). Unset: no tunnel service; remote access stays down
  HOPPER_LANE_POOL_KEY                    the lane pool key (64 hex, openssl rand -hex 32) lane pods join with: each joins
                                          as a machine of the first user, under its pod's name. Unset: no lane pool

Once it runs (default port 4790):
  UI              http://127.0.0.1:4790/        sign in with GitHub: the first person to do so is the admin
  API reference   http://127.0.0.1:4790/docs/
  operator CLI    hopper help

Read on: README.md, docs/deploy.md, docs/sign-in.md, docs/plugins.md.
`;
}

/** A secret among the settings: also read from a mounted file, `<name>_FILE`. */
const SECRET_SETTINGS = ['HOPPER_DATABASE_URL'];
/**
 * Read by the parts, not here (design.md "Target authentication"): the hopper's ssh key;
 * and the GitHub App's client secret, read by sign-in at each use (issue #258).
 */
const PART_SETTINGS = [
  'HOPPER_SSH_KEY', 'HOPPER_SSH_KEY_FILE', 'HOPPER_GITHUB_CLIENT_SECRET', 'HOPPER_GITHUB_CLIENT_SECRET_FILE',
  // The master key and the old token key, read at start (src/secrets/master-key.ts, issue #659).
  ...MASTER_KEY_VARIABLES,
  // Read by access at each call to OpenFGA (src/authz/openfga.ts, issue #559).
  'HOPPER_OPENFGA_KEY', 'HOPPER_OPENFGA_KEY_FILE',
  // Read by the vault's client at each call to the vault container (src/vault/remote.ts, issue #586).
  'HOPPER_VAULT_KEY', 'HOPPER_VAULT_KEY_FILE',
  // Read at each ask of the tunnel service (src/http/remote-access.ts, issue #880).
  'HOPPER_TUNNEL_KEY', 'HOPPER_TUNNEL_KEY_FILE',
  // Read at each join of a lane pod (src/machines/lane-pool.ts, issue #1284).
  'HOPPER_LANE_POOL_KEY', 'HOPPER_LANE_POOL_KEY_FILE',
  // A pod's own limits, read by the resource meter (src/client/cluster.ts, issue #1289).
  'HOPPER_POD_CPU_LIMIT', 'HOPPER_POD_MEMORY_LIMIT',
];
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
    ...(e.HOPPER_HEALTH_PORT === undefined ? {} : { healthPort: e.HOPPER_HEALTH_PORT }),
    databaseUrl: e.HOPPER_DATABASE_URL,
    workDir: e.HOPPER_WORK_DIR,
    tickMs: e.HOPPER_TICK_MS,
    softLimit: e.HOPPER_SOFT_LIMIT,
    hardLimit: e.HOPPER_HARD_LIMIT,
    pacing: {
      burnWindowMs: e.HOPPER_BURN_WINDOW_HOURS * 3_600_000,
      resetAwarePlacement: e.HOPPER_RESET_AWARE_PLACEMENT,
      criticalPriority: e.HOPPER_CRITICAL_PRIORITY,
    },
    routerCheapBoost: e.HOPPER_ROUTER_CHEAP_BOOST,
    webhookBaseMs: e.HOPPER_WEBHOOK_BASE_MS,
    laneIdleGraceMs: e.HOPPER_LANE_IDLE_GRACE_MS,
    reconnectGraceMs: e.HOPPER_RECONNECT_GRACE_MS,
    linkGraceMs: e.HOPPER_LINK_GRACE_MS,
    doneRecheckMs: e.HOPPER_DONE_RECHECK_MS, doneReadRetryMs: e.HOPPER_DONE_READ_RETRY_MS,
    checksWaitMs: e.HOPPER_CHECKS_WAIT_MS,
    ownCommandGraceMs: e.HOPPER_OWN_COMMAND_GRACE_MS,
    answerTimeoutMs: e.HOPPER_ANSWER_TIMEOUT_MS,
    humanRenotifyMs: e.HOPPER_HUMAN_RENOTIFY_MS,
    humanTimeoutMs: e.HOPPER_HUMAN_TIMEOUT_MS,
    resumeBoost: e.HOPPER_RESUME_BOOST,
    maxQuestions: e.HOPPER_MAX_QUESTIONS,
    keepPanes: e.HOPPER_KEEP_PANES,
    localMachine: e.HOPPER_LOCAL_MACHINE,
    ...(e.HOPPER_PLUGIN_DIR ? { pluginDir: e.HOPPER_PLUGIN_DIR } : {}),
    ...(e.HOPPER_PLUGIN_STORE ? { pluginStore: e.HOPPER_PLUGIN_STORE } : {}),
    publicUrl: e.HOPPER_PUBLIC_URL,
    tunnelApis: { ...(e.HOPPER_TUNNEL_API ? { ngrok: e.HOPPER_TUNNEL_API } : {}), ...(e.HOPPER_CLOUDFLARED_API ? { cloudflare: e.HOPPER_CLOUDFLARED_API } : {}) },
    lanNames: e.HOPPER_LAN_NAMES,
    lanPeers: e.HOPPER_LAN_PEERS,
    updateCheckMs: e.HOPPER_UPDATE_CHECK_MS,
    ...(e.HOPPER_RESTART ? { restart: e.HOPPER_RESTART } : {}),
    ...(e.HOPPER_OPENFGA_URL ? { openFgaUrl: e.HOPPER_OPENFGA_URL } : {}),
    ...(e.HOPPER_SOLR_URL ? { solrUrl: e.HOPPER_SOLR_URL } : {}),
    ...(e.HOPPER_VAULT_URL ? { vaultUrl: e.HOPPER_VAULT_URL } : {}),
    ...(e.HOPPER_KMS_REGION ? { kms: { region: e.HOPPER_KMS_REGION, key: e.HOPPER_KMS_KEY, ...(e.HOPPER_KMS_URL ? { url: e.HOPPER_KMS_URL } : {}) } }
      : e.HOPPER_KMS_URL ? { kms: { url: e.HOPPER_KMS_URL, key: e.HOPPER_KMS_KEY } } : {}),
    ...sandboxSettings(e),
    leftoverEnv,
    hopperApps: hopperApps({
      github: {
        ...(e.HOPPER_GITHUB_URL ? { url: e.HOPPER_GITHUB_URL } : {}), ...(e.HOPPER_GITHUB_CLIENT_ID ? { clientId: e.HOPPER_GITHUB_CLIENT_ID } : {}),
        ...(e.HOPPER_GITHUB_APP_SLUG ? { slug: e.HOPPER_GITHUB_APP_SLUG } : {}),
      }
    }),
  };
}
