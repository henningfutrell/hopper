#!/usr/bin/env node
// The operator's command line (design.md "Config documents", "Operator CLI"): it opens the same
// database as the daemon (HOPPER_DATABASE_URL, or the file HOPPER_DATABASE_URL_FILE names), so whoever runs it holds the database's
// credentials — the same trust as the daemon's own environment, more than a UI session's. This is
// where command-bearing options are set: the UI never edits them.
//
//   hopper config get <document>                      print it (stdout)
//   hopper config version <document>                  print its version
//   hopper config set <document> --if-version <v>     replace it from stdin, if still at <v>
//   hopper config edit <document>                     $EDITOR on it, written back against the version read
//   hopper login-code [--link <base url>]             mint a one-time UI login code (stdout)
//   hopper password-hash                              an argon2id hash of a password (stdin) for auth.yaml
//   hopper help                                       what each command does
//
// <document>: plugins.yaml, rules.md or auth.yaml. A document that would not load is refused.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { read } from 'read';
import { parse } from 'yaml';
import { CONFIG_DOCUMENTS, type ConfigDocumentName, type Store } from './domain/ports.ts';
import { authDocumentProblem, hashPassword } from './auth/index.ts';
import { LOGIN_CODE_MINUTES, mintLoginCode } from './http/ui/login-code.ts';
import { pluginsFileProblem } from './plugins/plugins-file.ts';
import { RULES_MAX_BYTES } from './questions/index.ts';
import { openStore } from './store/index.ts';
import { runtimeSecrets } from './secrets/runtime.ts';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdin(): string;
  out(text: string): void;
  err(text: string): void;
  /** Run the editor on a file; resolves when it exits. Default: $VISUAL / $EDITOR / vi on the terminal. */
  edit?(file: string): number;
  /** The password for password-hash. Default: the first line of stdin. */
  password?(): Promise<string>;
}

const USAGE = `hopper: the operator command line. It works on the daemon's database directly.

usage:
  hopper config get <document>                       print a config document
  hopper config version <document>                   print its version
  hopper config set <document> --if-version <v>      replace it from stdin, if still at <v> ("missing" for a new one)
  hopper config edit <document>                      edit it in $EDITOR, written back against the version read
  hopper login-code [--link <base url>]              a one-time UI login code (${LOGIN_CODE_MINUTES} minutes), or a link with it
  hopper password-hash                               an argon2id hash for auth.yaml password.users (password on stdin, or typed)
  hopper help                                        this text

documents: ${CONFIG_DOCUMENTS.join(', ')}

Every command but password-hash and help needs HOPPER_DATABASE_URL (or HOPPER_DATABASE_URL_FILE):
the database the daemon uses, postgres://user:password@host:port/database.

First sign-in:  hopper login-code --link http://127.0.0.1:4790   then open the link
The daemon:     node src/main.ts --help   (its settings)
API reference:  http://127.0.0.1:4790/docs/ on a running daemon
Read on:        README.md, docs/deploy.md, docs/sign-in.md`;

class CliError extends Error {}

function documentName(raw: string | undefined): ConfigDocumentName {
  if (raw && (CONFIG_DOCUMENTS as readonly string[]).includes(raw)) return raw as ConfigDocumentName;
  throw new CliError(`unknown document ${raw ?? '(none)'}; one of ${CONFIG_DOCUMENTS.join(', ')}`);
}

/** Why `text` would not load as `name`, or undefined. */
export function documentProblem(name: ConfigDocumentName, text: string): string | undefined {
  if (name === 'rules.md') {
    const bytes = Buffer.byteLength(text, 'utf8');
    return bytes > RULES_MAX_BYTES ? `the rules may hold at most 64 KiB; this is ${bytes} bytes` : undefined;
  }
  let raw: unknown;
  try { raw = parse(text); } catch (e) { return `not valid YAML: ${(e as Error).message}`; }
  return name === 'auth.yaml' ? authDocumentProblem(raw) : pluginsFileProblem(raw);
}

function put(store: Store, name: ConfigDocumentName, text: string, version: string): void {
  const problem = documentProblem(name, text);
  if (problem) throw new CliError(`${name} refused, nothing written: ${problem}`);
  if (!store.documents.write(name, text, version)) {
    throw new CliError(`${name} changed since version ${version} (now ${store.documents.version(name)}); nothing written`);
  }
}

function defaultEditor(env: CliIo['env']) {
  return (file: string): number => {
    const editor = env.VISUAL || env.EDITOR || 'vi';
    return spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'editor', file], { stdio: 'inherit' }).status ?? 1;
  };
}

function config(store: Store, args: string[], io: CliIo): void {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'if-version': { type: 'string' } } });
  const [verb, rawName] = positionals;
  const name = documentName(rawName);
  if (verb === 'get') {
    const text = store.documents.read(name);
    if (text === undefined) throw new CliError(`${name}: none yet (version missing)`);
    io.out(text);
  } else if (verb === 'version') {
    io.out(`${store.documents.version(name)}\n`);
  } else if (verb === 'set') {
    const version = values['if-version'];
    if (!version) throw new CliError('config set needs --if-version <version> (hopper config version <document>), so nobody else\'s edit is overwritten');
    put(store, name, io.stdin(), version);
    io.err(`${name} written (version ${store.documents.version(name)})\n`);
  } else if (verb === 'edit') {
    const version = store.documents.version(name);
    const dir = mkdtempSync(join(tmpdir(), 'hopper-edit-'));
    const file = join(dir, name);
    try {
      const before = store.documents.read(name) ?? '';
      writeFileSync(file, before, { mode: 0o600 });
      const status = (io.edit ?? defaultEditor(io.env))(file);
      if (status !== 0) throw new CliError(`the editor exited ${status}; nothing written`);
      const after = readFileSync(file, 'utf8');
      if (after === before) { io.err(`${name} unchanged\n`); return; }
      put(store, name, after, version);
      io.err(`${name} written (version ${store.documents.version(name)})\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } else {
    throw new CliError(USAGE);
  }
}

/** One fresh login code on stdout (or the device link with it); its expiry on stderr. */
function loginCode(store: Store, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { link: { type: 'string' } } });
  const code = mintLoginCode(store, { now: () => new Date() });
  io.out(values.link ? `${values.link.replace(/\/+$/, '')}/#login=${code}\n` : `${code}\n`);
  io.err(`login code minted: works once, for ${LOGIN_CODE_MINUTES} minutes\n`);
}

/** An argon2id hash of one password on stdout, for auth.yaml `password.users` (design.md "Sign-in"). Needs no database. */
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
  if (command !== 'config' && command !== 'login-code') {
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
  let store: Store | undefined;
  try {
    store = openStore({ url, clock: { now: () => new Date() } });
    if (command === 'login-code') loginCode(store, rest, io);
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
