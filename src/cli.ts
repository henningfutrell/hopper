#!/usr/bin/env node
// The operator's command line (design.md "Config in the database", "Operator CLI"): it opens the same
// database as the daemon (HOPPER_DATABASE_URL, or the file HOPPER_DATABASE_URL_FILE names), so whoever
// runs it holds the database's credentials — the same trust as the daemon's own environment. Every
// setting is edited in the UI; `config` reads and replaces a config record as JSON, for scripts and for
// mending one the UI cannot load.
//
//   hopper config get <record> [--user <id>]         print it as JSON (stdout)
//   hopper config version <record> [--user <id>]     print its version
//   hopper config set <record> --if-version <v>       replace it with the JSON on stdin, if still at <v>
//   hopper users                                      list the users (issue #158)
//   hopper user add <name>                            add a user
//   hopper user transfer <from> <to>                  <to> takes over <from>'s work (issue #212)
//   hopper join-code [--user <id>]                    a one-time join code: a machine joins with <hopper URL>#<code> (issue #308)
//   hopper pool-key [--user <id>] [--revoke]          a lane pool key for lane pods of another release (issue #1454)
//   hopper ssh-key [--user <id>]                      the public half of the hopper's ssh key (issue #307)
//   hopper ledger rebuild [--user <id>]               the work-item ledger replayed from every event (issue #1067)
//   hopper local-account list|add|password|remove     the local accounts, a password on stdin (issue #1380, cli-local-accounts.ts)
//   hopper job|queue|question … [--user <id>] [--url <hopper URL>]
//                                                     an operator action on the running daemon (issue #374, cli-operator.ts)
//   hopper problem|handoff|failure … [--user <id>] [--url <hopper URL>]
//                                                     the Failures actions on the running daemon (issue #623, cli-operator.ts)
//   hopper proposal list|paths|select|accept|more-paths|steer|reject …
//                                                     the proposals' paths on the running daemon (issue #651, cli-operator.ts)
//   hopper master-key status [--url <hopper URL>]     the master key's source and fingerprint, never the key (issue #685, cli-operator.ts)
//   hopper master-key rotate [--url <hopper URL>]     a new master key, every secret sealed again under it; prints it once (issue #659)
//   hopper cluster script                             the host's cluster script: bootstrap, migrate, rollback (issue #1373)
//   hopper lanes plan|costs|tune|apply|dismiss|undo …
//                                                     lane recommendations, job cost profiles and a machine's lane tuning (issue #688, cli-operator-lanes.ts)
//   hopper machine list|drain|undrain …               the machines, drained or not; drain or undrain one (issue #1511, cli-operator-machine.ts)
//   hopper vault|template|sandbox …                   vault secrets (value on stdin), templates and sandbox boxes (issue #716, cli-operator-vault.ts)
//   hopper update <tool>|compose|skill                the update of a container install, no database (issue #697, cli-update.ts)
//   hopper update drift [--url <hopper URL>]          the running stack's drift from its compose file (issue #1017, cli-update-drift.ts)
//   hopper help                                       what each command does
//
// There is no login from here (issue #238: no bootstrap login): people sign in through a realm or a local account, and a
// hopper with no identity provider gets its first admin from `hopper local-account add` (issue #1380). An agent with a grant — a
// delegate approver (issue #1138) — runs the operator actions with no database: HOPPER_REFRESH_TOKEN_FILE names the file
// that holds the grant's refresh token, HOPPER_URL (or --url) the hopper.
//
// <record>: plugins, rules or job-rules (a user's: --user, default the one user), or sign-in (the instance's). A
// record that would not load is refused.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { windowsHostsProblem } from './domain/windows-steps.ts';
import { clustersProblem } from './domain/clusters.ts'; import { podmanHostsProblem } from './domain/podman-hosts.ts';
import { CONFIG_NAMES, type ConfigName, type ConfigRecords, type InstanceStore } from './domain/ports.ts';
import type { User } from './domain/types.ts';
import { signInConfigProblem } from './auth/config.ts';
import { withHeldSecrets } from './auth/sealed-secrets.ts';
import { jobRulesProblem } from './job-rules/index.ts';
import { repoJobRulesProblem } from './job-rules/repo-rules.ts';
import { pluginsConfigProblem } from './plugins/plugins-config.ts';
import { rulesProblem } from './questions/index.ts';
import { openInstanceStore } from './store/index.ts';
import { openInstanceSecrets } from './users/instance-secrets.ts';
import { mintJoinCode } from './machines/join-code.ts';
import { issueLanePoolKey } from './machines/lane-pool.ts';
import { launchKey, withMasterKey } from './secrets/master-key.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { OPERATOR_COMMANDS, OPERATOR_USAGE, REFRESH_TOKEN_FILE, runOperatorAction, runOperatorActionWithGrant } from './cli-operator.ts';
import { OperatorRefusal } from './cli-operator-call.ts';
import { printHostScript, runUpdate, UPDATE_USAGE } from './cli-update.ts';
import { LOCAL_ACCOUNT_USAGE, LocalAccountUsage, localAccountCommand } from './cli-local-accounts.ts';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdin(): string;
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `hopper: the operator command line. It works on the daemon's database directly.

usage:
  hopper config get <record>                         print a config record as JSON
  hopper config version <record>                     print its version
  hopper config set <record> --if-version <v>        replace it with the JSON on stdin, if still at <v> ("missing" for a new one)
  hopper users                                       the users of this hopper: id, name, when added
  hopper user add <name>                             add a user: their own jobs, questions and settings, kept apart
  hopper user transfer <from> <to>                   <to> takes over everything <from> holds: <to>'s sign-ins land on
                                                     <from>'s work, under <to>'s name; <to>'s own empty record goes.
                                                     The daemon must be stopped; refused when <to> holds work of its own
  hopper join-code                                   a one-time join code (10 minutes) for a script that adds machines:
                                                     the machine joins with <hopper URL>#<code>, as Add machine's line does
  hopper pool-key [--revoke]                         a new lane pool key, in place of the one before, for lane pods of a
                                                     chart release outside this hopper (Add machine's Pod / Kubernetes);
                                                     --revoke: no pod joins with it any more. No restart either way
  hopper ssh-key                                     the public half of the hopper's ssh key, the line a machine's
                                                     authorized_keys takes (a script that adds a machine asks it)
  hopper ledger rebuild                              the work-item ledger replayed from every event and the issue graph,
                                                     in place of the rows there are; prints how many items it holds
${LOCAL_ACCOUNT_USAGE}
${OPERATOR_USAGE}
${UPDATE_USAGE}
  hopper service script                              print the host's user-service script (scripts/hopper-service.sh): it
                                                     puts a Podman compose stack under a user service. No daemon needed
  hopper cluster script                              print the host's cluster script (scripts/hopper-cluster.sh): it makes a
                                                     cluster on this host and moves the compose install onto it
                                                     (docs/kubernetes.md). No daemon needed
  hopper help                                        this text

With ${REFRESH_TOKEN_FILE} set, the operator actions (job … windows-link) open no database: they act with the grant whose
refresh token that file holds (a delegate approver's, minted on Access requests), on the hopper HOPPER_URL or --url names.
Each use writes the grant's new refresh token to the file. The grant's scopes decide what it may do.

The operator actions, every command from job to windows-link above, act on the running daemon, through its own checks
and events, as the UI does: --url names it (default HOPPER_URL, else http://127.0.0.1:<HOPPER_PORT, default 4790>).
No sign-in is needed: the CLI holds the database's credentials. Each prints the daemon's answer as JSON; the events
say the operator CLI acted (via cli).

records: ${CONFIG_NAMES.join(', ')}. plugins, rules, job-rules, repo-job-rules, windows-hosts, clusters and podman-hosts are one user's; sign-in is shared.
Every one is edited in the UI too. clusters: how the vault finds a cluster in the AWS accounts (Settings → Clusters).
--user <id> on config, ssh-key, ledger and the commands on the running daemon names the user (default: the one user, while there is one).

Every command but help and update (but update drift) needs HOPPER_DATABASE_URL (or HOPPER_DATABASE_URL_FILE):
the database the daemon uses, postgres://user:password@host:port/database.

First sign-in:  sign in with GitHub in the UI; the first person to sign in with GitHub is the admin (docs/sign-in.md)
The daemon:     node src/main.ts --help   (its settings)
API reference:  http://127.0.0.1:4790/docs/ on a running daemon
Read on:        README.md, docs/deploy.md, docs/sign-in.md`;

class CliError extends Error {}

function recordName(raw: string | undefined): ConfigName {
  if (raw && (CONFIG_NAMES as readonly string[]).includes(raw)) return raw as ConfigName;
  throw new CliError(`unknown config record ${raw ?? '(none)'}; one of ${CONFIG_NAMES.join(', ')}`);
}

/**
 * Why `value` would not load as `name`, or undefined. `held`: the realms' secrets the instance's vault keeps (issue
 * #658) — the `sign-in` record no longer holds them, so a realm that needs one is checked as having it.
 */
export function recordProblem(name: ConfigName, value: unknown, held: readonly string[] = []): string | undefined {
  if (name === 'rules') return rulesProblem(value);
  if (name === 'job-rules') return jobRulesProblem(value);
  if (name === 'repo-job-rules') return repoJobRulesProblem(value);
  if (name === 'windows-hosts') return windowsHostsProblem(value);
  if (name === 'clusters') return clustersProblem(value);
  if (name === 'podman-hosts') return podmanHostsProblem(value);
  return name === 'sign-in' ? signInConfigProblem(withHeldSecrets(value, held)) : pluginsConfigProblem(value);
}

/** One config record wherever it lives: a user's (plugins, rules, job-rules, repo-job-rules, windows-hosts, clusters, podman-hosts) or the instance's (sign-in). */
type Records = ConfigRecords<ConfigName>;

function put(records: Records, name: ConfigName, json: string, version: string, held: readonly string[]): void {
  let value: unknown;
  try { value = JSON.parse(json); } catch (e) { throw new CliError(`${name} refused, nothing written: not valid JSON: ${(e as Error).message}`); }
  const problem = recordProblem(name, value, held);
  if (problem) throw new CliError(`${name} refused, nothing written: ${problem}`);
  if (!records.write(name, value, version)) {
    throw new CliError(`${name} changed since version ${version} (now ${records.version(name)}); nothing written`);
  }
}

/** The user `--user` names, or the one user. */
function userOf(instance: InstanceStore, id: string | undefined): User {
  if (id === undefined) {
    const all = instance.users.list();
    if (all.length === 0) throw new CliError('no user yet: the first sign-in makes one');
    if (all.length > 1) throw new CliError(`several users: name one with --user (${all.map((u) => u.id).join(', ')})`);
    return all[0]!;
  }
  const user = instance.users.get(id);
  if (!user) throw new CliError(`no user ${id}; hopper users lists them`);
  return user;
}

/** Run `fn` with the records `name` lives in: sign-in the instance's, the others the user's (default the one user). */
function withRecords<T>(instance: InstanceStore, name: ConfigName, userId: string | undefined, fn: (records: Records) => T): T {
  if (name === 'sign-in') {
    if (userId !== undefined) throw new CliError('sign-in is the instance\'s (sign-in is shared): no --user');
    return fn(instance.config as Records);
  }
  const store = instance.userStore(userOf(instance, userId));
  try {
    return fn(store.config as Records);
  } finally {
    store.close();
  }
}

function config(instance: InstanceStore, args: string[], io: CliIo): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'if-version': { type: 'string' }, user: { type: 'string' } } });
  const [verb, rawName] = positionals;
  const name = recordName(rawName);
  const held = name === 'sign-in' ? instance.vault.list().map((s) => s.name) : [];
  withRecords(instance, name, values.user, (records) => configVerb(records, name, verb, values['if-version'], io, held));
}

function configVerb(records: Records, name: ConfigName, verb: string | undefined, ifVersion: string | undefined, io: CliIo, held: readonly string[]): void {
  if (verb === 'get') {
    const value = records.read(name);
    if (value === undefined) throw new CliError(`${name}: none yet (version missing)`);
    io.out(`${JSON.stringify(value, null, 2)}\n`);
  } else if (verb === 'version') {
    io.out(`${records.version(name)}\n`);
  } else if (verb === 'set') {
    if (!ifVersion) throw new CliError('config set needs --if-version <version> (hopper config version <record>), so nobody else\'s edit is overwritten');
    put(records, name, io.stdin(), ifVersion, held);
    io.err(`${name} written (version ${records.version(name)})\n`);
  } else {
    throw new CliError(USAGE);
  }
}

/** `hopper users`: one line per user, oldest first: id, name, when added (tab-separated). */
function users(instance: InstanceStore, io: CliIo): void {
  for (const u of instance.users.list()) io.out(`${u.id}\t${u.name}\t${u.createdAt}\n`);
}

/**
 * `hopper user transfer <from> <to>` (issue #212): the user a person signs in as (`to`) takes over the
 * work another holds (`from`). The record holding the work stays — its user schema, work dir, secrets and
 * herdr session with it, so running jobs are untouched — and takes `to`'s name and sign-ins. Only with
 * the daemon stopped: it keeps a runtime per user.
 */
function transfer(instance: InstanceStore, args: string[], io: CliIo): void {
  const [fromId, toId, ...extra] = args;
  if (!fromId || !toId || extra.length > 0) throw new CliError('usage: hopper user transfer <from> <to>');
  for (const id of [fromId, toId]) userOf(instance, id);
  if (fromId === toId) throw new CliError('a transfer needs two different users');
  if (!instance.holdSoleLock()) throw new CliError('a running daemon has this database; stop it first (systemctl --user stop hopper), then start it again after');
  let kept: User;
  try {
    kept = instance.users.transfer(fromId, toId);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  io.out(`${kept.id}\t${kept.name}\n`);
  io.err(`${kept.name} now holds ${fromId}'s work: sign in as ${kept.name} to reach it (user id ${kept.id}). Start the daemon again.\n`);
}

/** `hopper user add <name>`: the new user's id on stdout. A running daemon starts its runtime when it next reads the users. */
function userCommand(instance: InstanceStore, args: string[], io: CliIo): void {
  if (args[0] === 'transfer') { transfer(instance, args.slice(1), io); return; }
  const [verb, name, ...extra] = args;
  if (verb !== 'add' || !name?.trim() || extra.length > 0) throw new CliError('usage: hopper user add <name> | hopper user transfer <from> <to>');
  if (instance.users.list().some((u) => u.name.toLowerCase() === name.trim().toLowerCase())) throw new CliError(`the name ${name.trim()} is taken`);
  const user = instance.users.add(name);
  io.out(`${user.id}\n`);
  io.err(`user ${user.id} added: link a sign-in to it with hopper user transfer ${user.id} <the user a sign-in made>\n`);
}

/** `hopper join-code [--user <id>]` (issue #308): a one-time join code for that user (default the one user) on stdout. */
function joinCode(instance: InstanceStore, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { user: { type: 'string' } } });
  const user = userOf(instance, values.user);
  const { code, expiresAt } = mintJoinCode(instance, { now: () => new Date() }, user.id);
  io.out(`${code}\n`);
  io.err(`a join code for ${user.name}, once, until ${expiresAt}: the machine joins with <hopper URL>#<code>\n`);
}

/**
 * `hopper pool-key [--user <id>] [--revoke]` (issue #1454): a new lane pool key for that user (default the one user) on
 * stdout, in place of the one it had, for lane pods of a chart release outside this hopper; `--revoke`: none any more.
 */
function poolKey(instance: InstanceStore, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { user: { type: 'string' }, revoke: { type: 'boolean' } } });
  const user = userOf(instance, values.user);
  if (values.revoke) {
    io.err(instance.lanePoolKeys.remove(user.id) ? `the lane pool key of ${user.name} is revoked: no pod joins with it any more\n` : `${user.name} has no lane pool key\n`);
    return;
  }
  const { key } = issueLanePoolKey(instance, { now: () => new Date() }, user.id);
  io.out(`${key}\n`);
  io.err(`a lane pool key for ${user.name}, in place of any before: lane pods join with <hopper URL>#<key> (docs/deploy.md "Lane pods of another release")\n`);
}

/** `hopper ssh-key`: the public half of the user's ssh key (issue #293), never its private half. */
function sshKey(instance: InstanceStore, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { user: { type: 'string' } } });
  const store = instance.userStore(userOf(instance, values.user));
  try {
    const key = store.settings.getSshKey();
    if (!key) throw new CliError('no ssh key yet: the daemon makes one when it starts; start it, then ask again');
    io.out(`${key.publicKey}\n`);
  } finally {
    store.close();
  }
}

/** `hopper ledger rebuild` (issue #1067): the user's work-item ledger replayed from every event and the issue graph. */
function ledger(instance: InstanceStore, args: string[], io: CliIo): void {
  const [action, ...rest] = args;
  if (action !== 'rebuild') throw new CliError('usage: hopper ledger rebuild [--user <id>]');
  const { values } = parseArgs({ args: rest, options: { user: { type: 'string' } } });
  const store = instance.userStore(userOf(instance, values.user));
  try {
    io.out(`${store.workItems.rebuild()}\n`);
    io.err(`${Object.entries(store.workItems.counts()).map(([state, n]) => `${state} ${n}`).join(', ')}\n`);
  } finally {
    store.close();
  }
}

const COMMANDS: readonly string[] = ['config', 'users', 'user', 'local-account', 'join-code', 'pool-key', 'ssh-key', 'ledger', 'update', ...OPERATOR_COMMANDS];

/** Run one command; the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(`${USAGE}\n`);
    return 0;
  }
  // `update drift` reads the running daemon (issue #1017); every other `update` command needs no database.
  if (command === 'update' && rest[0] !== 'drift') return runUpdate(rest, io);
  // The host's master-key script (issue #1296), user-service script (issue #1320) and cluster script (issue #1373) are files
  // of the build: no database.
  if ((command === 'master-key' || command === 'service' || command === 'cluster') && rest[0] === 'script') return printHostScript(command, rest.slice(1), io);
  if (command === undefined || !COMMANDS.includes(command)) {
    io.err(`${USAGE}\n`);
    return 2;
  }
  // An agent's grant (issue #1138): no database, only the hopper's routes.
  if (io.env[REFRESH_TOKEN_FILE] && (OPERATOR_COMMANDS as readonly string[]).includes(command)) {
    try {
      return await runOperatorActionWithGrant(command, rest, io);
    } catch (e) {
      io.err(`hopper: ${e instanceof Error ? e.message : String(e)}\n`);
      return e instanceof OperatorRefusal ? 2 : 1;
    }
  }
  let url: string | undefined;
  try {
    url = runtimeSecrets(io.env)('HOPPER_DATABASE_URL');
  } catch (e) {
    io.err(`hopper: ${(e as Error).message}\n`);
    return 2;
  }
  if (!url) {
    io.err('HOPPER_DATABASE_URL is not set (nor HOPPER_DATABASE_URL_FILE): the database the daemon uses (postgres://…)\n');
    return 2;
  }
  let store: InstanceStore | undefined;
  try {
    const clock = { now: () => new Date() };
    // The sign-in config with its realms' secrets from the instance's vault (issue #658), opened with the runtime's key.
    store = openInstanceStore({ url, clock });
    // The key as the daemon reads it (issue #1373): a previous-keys file that is not there gives no previous key.
    const keyed = withMasterKey(io.env, launchKey(io.env)).env;
    store = openInstanceSecrets(store, { env: keyed, clock, logger: { info: () => undefined, warn: (l) => io.err(`${l}\n`) } }).instance;
    if (command === 'users') users(store, io);
    else if (command === 'user') userCommand(store, rest, io);
    else if (command === 'join-code') joinCode(store, rest, io);
    else if (command === 'pool-key') poolKey(store, rest, io);
    else if (command === 'ssh-key') sshKey(store, rest, io);
    else if (command === 'ledger') ledger(store, rest, io);
    else if (command === 'config') config(store, rest, io);
    else if (command === 'local-account') await localAccountCommand(store, rest, io, clock.now);
    else {
      const instance = store;
      return await runOperatorAction(instance, command, rest, (id) => userOf(instance, id), io);
    }
    return 0;
  } catch (e) {
    io.err(`hopper: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof CliError || e instanceof OperatorRefusal || e instanceof LocalAccountUsage ? 2 : 1;
  } finally {
    store?.close();
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdin: () => readFileSync(0, 'utf8'),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
