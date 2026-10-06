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
//   hopper login-code [--user <id>] [--link <url>]    mint a one-time UI login code for a user (stdout)
//   hopper users                                      list the users (issue #158)
//   hopper user add <name>                            add a user
//   hopper password-hash                              an argon2id hash of a password (stdin) for a password realm
//   hopper help                                       what each command does
//
// <record>: plugins or rules (a user's: --user, default owner), or sign-in (the instance's). A
// record that would not load is refused.
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { read } from 'read';
import { CONFIG_NAMES, type ConfigName, type ConfigRecords, type InstanceStore } from './domain/ports.ts';
import type { User } from './domain/types.ts';
import { hashPassword, signInConfigProblem } from './auth/index.ts';
import { LOGIN_CODE_MINUTES, mintLoginCode } from './http/ui/login-code.ts';
import { pluginsConfigProblem } from './plugins/plugins-config.ts';
import { rulesProblem } from './questions/index.ts';
import { openInstanceStore } from './store/index.ts';
import { runtimeSecrets } from './secrets/runtime.ts';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdin(): string;
  out(text: string): void;
  err(text: string): void;
  /** The password for password-hash. Default: the first line of stdin. */
  password?(): Promise<string>;
}

const USAGE = `hopper: the operator command line. It works on the daemon's database directly.

usage:
  hopper config get <record>                         print a config record as JSON
  hopper config version <record>                     print its version
  hopper config set <record> --if-version <v>        replace it with the JSON on stdin, if still at <v> ("missing" for a new one)
  hopper login-code [--link <base url>]              a one-time UI login code (${LOGIN_CODE_MINUTES} minutes), or a link with it
  hopper users                                       the users of this hopper: id, name, when added
  hopper user add <name>                             add a user: their own jobs, questions and settings, kept apart
  hopper password-hash                               an argon2id hash for a password realm's users (password on stdin, or typed)
  hopper help                                        this text

records: ${CONFIG_NAMES.join(', ')}. plugins and rules are one user's; sign-in is shared. Every one is edited in the UI too.
--user <id> on config and login-code names the user (default: owner, the first user).

Every command but password-hash and help needs HOPPER_DATABASE_URL (or HOPPER_DATABASE_URL_FILE):
the database the daemon uses, postgres://user:password@host:port/database.

First sign-in:  hopper login-code --link http://127.0.0.1:4790   then open the link
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
  return name === 'sign-in' ? signInConfigProblem(value) : pluginsConfigProblem(value);
}

/** One config record wherever it lives: a user's (plugins, rules) or the instance's (sign-in). */
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

/** The user `--user` names, or owner. */
function userOf(instance: InstanceStore, id: string | undefined): User {
  if (id === undefined) return instance.users.owner();
  const user = instance.users.get(id);
  if (!user) throw new CliError(`no user ${id}; hopper users lists them`);
  return user;
}

/** Run `fn` with the records `name` lives in: sign-in the instance's, the others the user's (default owner). */
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

/** One fresh login code on stdout (or the device link with it); its expiry on stderr. */
function loginCode(instance: InstanceStore, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { link: { type: 'string' }, user: { type: 'string' } } });
  const code = mintLoginCode(instance, { now: () => new Date() }, userOf(instance, values.user).id);
  io.out(values.link ? `${values.link.replace(/\/+$/, '')}/#login=${code}\n` : `${code}\n`);
  io.err(`login code minted: works once, for ${LOGIN_CODE_MINUTES} minutes\n`);
}

/** `hopper users`: one line per user, oldest first: id, name, when added (tab-separated). */
function users(instance: InstanceStore, io: CliIo): void {
  for (const u of instance.users.list()) io.out(`${u.id}\t${u.name}\t${u.createdAt}\n`);
}

/** `hopper user add <name>`: the new user's id on stdout. A running daemon starts its runtime when it next reads the users. */
function userCommand(instance: InstanceStore, args: string[], io: CliIo): void {
  const [verb, name, ...extra] = args;
  if (verb !== 'add' || !name?.trim() || extra.length > 0) throw new CliError('usage: hopper user add <name>');
  if (instance.users.list().some((u) => u.name.toLowerCase() === name.trim().toLowerCase())) throw new CliError(`the name ${name.trim()} is taken`);
  const user = instance.users.add(name);
  io.out(`${user.id}\n`);
  io.err(`user ${user.id} added: hopper login-code --user ${user.id} gives a first sign-in\n`);
}

/** An argon2id hash of one password on stdout, for a password realm's `users` in the sign-in config (design.md "Sign-in: realms"). Needs no database. */
async function passwordHash(io: CliIo): Promise<number> {
  let password: string;
  try {
    password = io.password ? await io.password() : (io.stdin().split(/\r?\n/)[0] ?? '');
  } catch (e) {
    io.err(`hopper: ${(e as Error).message}\n`);
    return 2;
  }
  if (password === '') {
    io.err('hopper: the password is empty; nothing hashed\n');
    return 2;
  }
  io.out(`${await hashPassword(password)}\n`);
  return 0;
}

/** Run one command; the exit code (a promise for password-hash, the one command that hashes). */
export function runCli(argv: string[], io: CliIo): number | Promise<number> {
  const [command, ...rest] = argv;
  if (command === 'help' || command === '--help' || command === '-h') {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (command === 'password-hash') return passwordHash(io);
  if (command !== 'config' && command !== 'login-code' && command !== 'users' && command !== 'user') {
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
    if (command === 'login-code') loginCode(store, rest, io);
    else if (command === 'users') users(store, io);
    else if (command === 'user') userCommand(store, rest, io);
    else config(store, rest, io);
    return 0;
  } catch (e) {
    io.err(`hopper: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof CliError ? 2 : 1;
  } finally {
    store?.close();
  }
}

/** A password typed on the terminal without echo, asked twice; from a pipe, its first line. */
async function terminalPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8').split(/\r?\n/)[0] ?? '';
  const first = await read({ prompt: 'password: ', silent: true, output: process.stderr });
  const again = await read({ prompt: 'again: ', silent: true, output: process.stderr });
  if (first !== again) throw new CliError('the two passwords differ; nothing hashed');
  return first;
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdin: () => readFileSync(0, 'utf8'),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    password: terminalPassword,
  });
}
