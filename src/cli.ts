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
//   hopper ssh-key [--user <id>]                      the public half of the hopper's ssh key (issue #307)
//   hopper job|queue|question … [--user <id>] [--url <hopper URL>]
//                                                     an operator action on the running daemon (issue #374, cli-operator.ts)
//   hopper help                                       what each command does
//
// There is no login from here (issue #238: no bootstrap login): people sign in through a realm.
//
// <record>: plugins, rules or job-rules (a user's: --user, default the one user), or sign-in (the instance's). A
// record that would not load is refused.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { CONFIG_NAMES, type ConfigName, type ConfigRecords, type InstanceStore } from './domain/ports.ts';
import type { User } from './domain/types.ts';
import { signInConfigProblem } from './auth/config.ts';
import { jobRulesProblem } from './job-rules/index.ts';
import { pluginsConfigProblem } from './plugins/plugins-config.ts';
import { rulesProblem } from './questions/index.ts';
import { openInstanceStore } from './store/index.ts';
import { mintJoinCode } from './machines/join-code.ts';
import { runtimeSecrets } from './secrets/runtime.ts';
import { OPERATOR_COMMANDS, OPERATOR_USAGE, OperatorRefusal, runOperatorAction } from './cli-operator.ts';

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
  hopper ssh-key                                     the public half of the hopper's ssh key, the line a machine's
                                                     authorized_keys takes (scripts/agent-boxes.sh asks it)
${OPERATOR_USAGE}
  hopper help                                        this text

The job, queue and question commands act on the running daemon, through its own checks and events, as the UI
does: --url names it (default HOPPER_URL, else http://127.0.0.1:<HOPPER_PORT, default 4790>).

records: ${CONFIG_NAMES.join(', ')}. plugins, rules and job-rules are one user's; sign-in is shared. Every one is edited
in the UI too.
--user <id> on config, ssh-key and the job, queue and question commands names the user (default: the one user, while there is one).

Every command but help needs HOPPER_DATABASE_URL (or HOPPER_DATABASE_URL_FILE):
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

/** Why `value` would not load as `name`, or undefined. */
export function recordProblem(name: ConfigName, value: unknown): string | undefined {
  if (name === 'rules') return rulesProblem(value);
  if (name === 'job-rules') return jobRulesProblem(value);
  return name === 'sign-in' ? signInConfigProblem(value) : pluginsConfigProblem(value);
}

/** One config record wherever it lives: a user's (plugins, rules, job-rules) or the instance's (sign-in). */
type Records = ConfigRecords<ConfigName>;

function put(records: Records, name: ConfigName, json: string, version: string): void {
  let value: unknown;
  try { value = JSON.parse(json); } catch (e) { throw new CliError(`${name} refused, nothing written: not valid JSON: ${(e as Error).message}`); }
  const problem = recordProblem(name, value);
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
  withRecords(instance, name, values.user, (records) => configVerb(records, name, verb, values['if-version'], io));
}

function configVerb(records: Records, name: ConfigName, verb: string | undefined, ifVersion: string | undefined, io: CliIo): void {
  if (verb === 'get') {
    const value = records.read(name);
    if (value === undefined) throw new CliError(`${name}: none yet (version missing)`);
    io.out(`${JSON.stringify(value, null, 2)}\n`);
  } else if (verb === 'version') {
    io.out(`${records.version(name)}\n`);
  } else if (verb === 'set') {
    if (!ifVersion) throw new CliError('config set needs --if-version <version> (hopper config version <record>), so nobody else\'s edit is overwritten');
    put(records, name, io.stdin(), ifVersion);
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
  if (!instance.holdDaemonLock()) throw new CliError('a running daemon has this database; stop it first (systemctl --user stop hopper), then start it again after');
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

const COMMANDS: readonly string[] = ['config', 'users', 'user', 'join-code', 'ssh-key', ...OPERATOR_COMMANDS];

/** Run one command; the exit code. */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (command === undefined || !COMMANDS.includes(command)) {
    io.err(`${USAGE}\n`);
    return 2;
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
    store = openInstanceStore({ url, clock: { now: () => new Date() } });
    if (command === 'users') users(store, io);
    else if (command === 'user') userCommand(store, rest, io);
    else if (command === 'join-code') joinCode(store, rest, io);
    else if (command === 'ssh-key') sshKey(store, rest, io);
    else if (command === 'config') config(store, rest, io);
    else {
      const instance = store;
      await runOperatorAction(instance, command, rest, (id) => userOf(instance, id), io);
    }
    return 0;
  } catch (e) {
    io.err(`hopper: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof CliError || e instanceof OperatorRefusal ? 2 : 1;
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
