#!/usr/bin/env node
// The operator's command line (design.md "Config documents", "Operator CLI"): it opens the same
// database as the daemon (JOB_HOPPER_DATABASE_URL), so whoever runs it holds the database's
// credentials — the same trust as the daemon's own environment, more than a UI session's. This is
// where command-bearing options are set: the UI never edits them.
//
//   job-hopper config get <document>                      print it (stdout)
//   job-hopper config version <document>                  print its version
//   job-hopper config set <document> --if-version <v>     replace it from stdin, if still at <v>
//   job-hopper config edit <document>                     $EDITOR on it, written back against the version read
//   job-hopper migrate-local --from-sqlite <file> [--config-dir <dir>] --secrets-out <file>
//                                                         a local install into this (empty) database
//
// <document>: plugins.yaml, webhooks.yaml or rules.md. A document that would not load is refused.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';
import { CONFIG_DOCUMENTS, type ConfigDocumentName, type Store } from './domain/ports.ts';
import { MigrateRefusal, migrateLocal, secretsEnvFile } from './migrate/local.ts';
import { pluginsFileProblem } from './plugins/plugins-file.ts';
import { RULES_MAX_BYTES } from './questions/index.ts';
import { openStore } from './store/index.ts';
import { webhooksFileProblem } from './webhooks/config.ts';

export interface CliIo {
  env: Record<string, string | undefined>;
  stdin(): string;
  out(text: string): void;
  err(text: string): void;
  /** Run the editor on a file; resolves when it exits. Default: $VISUAL / $EDITOR / vi on the terminal. */
  edit?(file: string): number;
}

const USAGE = `usage:
  job-hopper config get <document>
  job-hopper config version <document>
  job-hopper config set <document> --if-version <version>   (text on stdin; version "missing" for a new one)
  job-hopper config edit <document>
  job-hopper migrate-local --from-sqlite <file> [--config-dir <dir>] --secrets-out <file>
documents: ${CONFIG_DOCUMENTS.join(', ')}`;

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
  return name === 'plugins.yaml' ? pluginsFileProblem(raw) : webhooksFileProblem(raw);
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
    if (!version) throw new CliError('config set needs --if-version <version> (job-hopper config version <document>), so nobody else\'s edit is overwritten');
    put(store, name, io.stdin(), version);
    io.err(`${name} written (version ${store.documents.version(name)})\n`);
  } else if (verb === 'edit') {
    const version = store.documents.version(name);
    const dir = mkdtempSync(join(tmpdir(), 'job-hopper-edit-'));
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

function migrateCommand(url: string, args: string[], io: CliIo): void {
  const { values } = parseArgs({ args, options: { 'from-sqlite': { type: 'string' }, 'config-dir': { type: 'string' }, 'secrets-out': { type: 'string' } } });
  const sqlite = values['from-sqlite'];
  const secretsOut = values['secrets-out'];
  if (!sqlite || !secretsOut) throw new CliError(`migrate-local needs --from-sqlite <file> and --secrets-out <file>\n${USAGE}`);
  // Written before anything moves, never over a file: the secrets have nowhere else to go.
  writeFileSync(secretsOut, '', { mode: 0o600, flag: 'wx' });
  try {
    const r = migrateLocal({ sqlite, target: url, ...(values['config-dir'] ? { configDir: values['config-dir'] } : {}), log: (l) => io.err(`${l}\n`) });
    writeFileSync(secretsOut, secretsEnvFile(r.secrets), { mode: 0o600 });
    io.err(`migrate: ${Object.keys(r.secrets).length} secret(s) written to ${secretsOut}: give them to the daemon's environment\n`);
  } catch (e) {
    rmSync(secretsOut, { force: true });
    throw e instanceof MigrateRefusal ? new CliError(e.message) : e;
  }
}

/** Run one command; the exit code. */
export function runCli(argv: string[], io: CliIo): number {
  const [command, ...rest] = argv;
  if (command !== 'config' && command !== 'migrate-local') {
    io.err(`${USAGE}\n`);
    return 2;
  }
  const url = io.env.JOB_HOPPER_DATABASE_URL;
  if (!url) {
    io.err('JOB_HOPPER_DATABASE_URL is not set: the database the daemon uses (sqlite:<path> or postgres://…)\n');
    return 2;
  }
  let store: Store | undefined;
  try {
    if (command === 'migrate-local') {
      migrateCommand(url, rest, io);
      return 0;
    }
    store = openStore({ url, clock: { now: () => new Date() } });
    config(store, rest, io);
    return 0;
  } catch (e) {
    io.err(`job-hopper: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof CliError ? 2 : 1;
  } finally {
    store?.close();
  }
}

if (import.meta.main) {
  process.exitCode = runCli(process.argv.slice(2), {
    env: process.env,
    stdin: () => readFileSync(0, 'utf8'),
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
  });
}
