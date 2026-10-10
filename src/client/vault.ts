// The vault on a machine (design.md "The vault", issue #558): how a job on a joined machine gets a vault
// secret just in time, never from its environment or a file. The client serves a socket in its client dir
// (the dir 700, the socket 600: only this user opens it) and writes the `hopper-secret` helper beside it
// (secret.ts). A job runs the helper; the helper asks the client over the socket for one secret, showing the job's
// proxy token (issue #563: derived for that job, honoured only while it is at work); the client asks the hopper at
// `POST /client/vault`, signed with the client token (signature.ts signVault), so the hopper knows the machine too.
// The hopper answers only a secret in the approved scope of the machine's template, for a job at work on it, sealed
// to that one request under the client token: AES-256-GCM under a key derived from the token, a fresh salt and the
// request's nonce, the secret's name and the job's token bound as authenticated data. The value
// crosses no wire in clear, is held only in memory, and is never written to this machine's disk.
// Imports nothing of hopper but its own directory: it is installed on the target as plain files.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { MACHINE_KEY_HEADER, USER_HEADER } from './link.ts';
import { REQUEST_HEADER, nonceOf, signVault } from './signature.ts';

/** Where a machine asks the hopper for a vault secret. */
export const VAULT_PATH = '/client/vault';
/** What an ask is sent as: the hopper keeps its bytes as signed. */
export const VAULT_CONTENT_TYPE = 'application/x-hopper-vault';
export const SOCKET_FILE = 'vault.sock';
export const HELPER_FILE = 'hopper-secret';
/** The helper's own variable: the socket it asks. Set by the helper's script, never by a job. */
export const SOCKET_VARIABLE = 'HOPPER_VAULT_SOCKET';
/** The variable a job finds the helper by (the hopper sets it from the client's `/release`). */
export const SECRET_HELPER_VARIABLE = 'HOPPER_SECRET';

const NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/** A job's proxy token (issue #563): `<user, base64url>.<job id>.<mac>`. */
const JOB_TOKEN = /^[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{1,200}\.[A-Za-z0-9_-]{1,200}$/;
const SALT = 32;
const NONCE = 12;
const TAG = 16;
const MAX_ASK = 4096;

/** A vault secret's name: a letter, then letters, digits, `_`, `.`, `-`; at most 64. */
export const isSecretName = (v: unknown): v is string => typeof v === 'string' && NAME.test(v);

/** What the vault mints (issue #580): an AWS role session or a Kubernetes token. */
export const MINT_FORMS = ['aws', 'kube'] as const;
export type MintForm = (typeof MINT_FORMS)[number];
const OPERATION = /^[a-z]{1,16}$/;
const ASSET = /^[a-z][a-z-]{0,39}\/[A-Za-z0-9][A-Za-z0-9._/+=,-]{0,199}$/;

/**
 * What a machine asks, for the job whose proxy token it shows: one vault secret, or a credential minted for an
 * operation on an asset (`kube read namespace/lab/web`, issue #580).
 */
export type VaultAsk = { name: string; token: string } | { mint: MintForm; operation: string; asset: string; token: string };

/** The ask in words, for a log line: the secret's name, or what is minted. */
export const askInWords = (a: VaultAsk): string => ('name' in a ? a.name : `${a.mint} ${a.operation} ${a.asset}`);

/** The ask in a body, or why it is none. */
export function askOf(v: unknown): VaultAsk | string {
  const b = (typeof v === 'object' && v !== null ? v : {}) as { name?: unknown; token?: unknown; mint?: unknown; operation?: unknown; asset?: unknown };
  if (typeof b.token !== 'string' || !JOB_TOKEN.test(b.token)) return 'token must be the job\'s proxy token (HOPPER_TOKEN_FILE)';
  if (b.mint === undefined) return isSecretName(b.name) ? { name: b.name, token: b.token } : 'name must be a vault secret\'s name';
  if (!(MINT_FORMS as readonly unknown[]).includes(b.mint)) return `mint must be one of ${MINT_FORMS.join(', ')}`;
  if (typeof b.operation !== 'string' || !OPERATION.test(b.operation)) return 'operation must be an operation: read, write, sync or apply';
  if (typeof b.asset !== 'string' || !ASSET.test(b.asset)) return 'asset must be KIND/NAME, as cluster/prod or namespace/prod/web';
  return { mint: b.mint as MintForm, operation: b.operation, asset: b.asset, token: b.token };
}

/** The hopper's answer: the value sealed to the request, base64url. */
export interface SealedAnswer { salt: string; nonce: string; body: string }

const answerKey = (token: string, salt: Buffer, requestNonce: string): Buffer =>
  Buffer.from(hkdfSync('sha256', Buffer.from(token, 'utf8'), salt, `hopper vault answer v1\0${requestNonce}`, 32));
const aad = (ask: VaultAsk): Buffer =>
  Buffer.from('name' in ask ? `${ask.name}\0${ask.token}` : `mint\0${ask.mint}\0${ask.operation}\0${ask.asset}\0${ask.token}`, 'utf8');

/** `value` sealed to the request whose nonce is `requestNonce`, under the client token. */
export function sealAnswer(token: string, requestNonce: string, ask: VaultAsk, value: string): SealedAnswer {
  const salt = randomBytes(SALT);
  const nonce = randomBytes(NONCE);
  const key = answerKey(token, salt, requestNonce);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aad(ask));
    const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { salt: salt.toString('base64url'), nonce: nonce.toString('base64url'), body: body.toString('base64url') };
  } finally {
    key.fill(0);
  }
}

/** The value in the hopper's answer to the request whose nonce is `requestNonce`; throws when it does not open. */
export function openAnswer(token: string, requestNonce: string, ask: VaultAsk, answer: unknown): string {
  const a = (typeof answer === 'object' && answer !== null ? answer : {}) as Partial<Record<keyof SealedAnswer, unknown>>;
  if (typeof a.salt !== 'string' || typeof a.nonce !== 'string' || typeof a.body !== 'string') throw new Error('the hopper\'s answer is not a sealed answer');
  const salt = Buffer.from(a.salt, 'base64url');
  const nonce = Buffer.from(a.nonce, 'base64url');
  const body = Buffer.from(a.body, 'base64url');
  if (salt.length !== SALT || nonce.length !== NONCE || body.length < TAG) throw new Error('the hopper\'s answer is not a sealed answer');
  const key = answerKey(token, salt, requestNonce);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(aad(ask));
    decipher.setAuthTag(body.subarray(body.length - TAG));
    return Buffer.concat([decipher.update(body.subarray(0, body.length - TAG)), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('the hopper\'s answer cannot be opened: it was altered, or it is not for this request');
  } finally {
    key.fill(0);
  }
}

/** Asks the hopper this machine joined for a vault secret: signed, and the answer opened here. */
export const askHopper = (o: { url: string; user: string; key: string; token: () => string }) => async (ask: VaultAsk): Promise<string> => {
  const body = JSON.stringify(ask);
  const token = o.token();
  const signature = signVault(token, o.user, o.key, body);
  let res: Response;
  try {
    res = await fetch(new URL(VAULT_PATH, o.url), {
      method: 'POST',
      headers: { 'content-type': VAULT_CONTENT_TYPE, [USER_HEADER]: o.user, [MACHINE_KEY_HEADER]: o.key, [REQUEST_HEADER]: signature },
      body,
    });
  } catch (e) {
    throw new Error(`could not reach the hopper at ${o.url}: ${(e as Error).message}`, { cause: e });
  }
  const text = await res.text();
  let answer: { error?: unknown } = {};
  try { answer = JSON.parse(text) as typeof answer; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`the hopper refused (${res.status}): ${typeof answer.error === 'string' ? answer.error : text.slice(0, 200)}`);
  return openAnswer(token, nonceOf(signature), ask, answer);
};

export interface VaultOptions {
  /** The client dir: the socket and the helper go in it. */
  dir: string;
  /** The client's install dir: the helper runs its secret.ts. */
  installDir: string;
  /** Asks the hopper (askHopper); a refusal throws, saying why. */
  ask: (ask: VaultAsk) => Promise<string>;
  /** The node that runs the helper; default this one. */
  node?: string;
  log?: (line: string) => void;
}

export interface Vault {
  socket: string;
  /** The helper a job runs: given to it as HOPPER_SECRET. */
  helper: string;
  stop(): Promise<void>;
}

const quote = (s: string): string => `'${s.replaceAll('\'', '\'\\\'\'')}'`;

/** Serves the vault's socket and writes the helper. One ask per connection: a line of JSON in, a line of JSON out. */
export function startVault(o: VaultOptions): Promise<Vault> {
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  chmodSync(o.dir, 0o700);
  const socket = join(o.dir, SOCKET_FILE);
  const helper = join(o.dir, HELPER_FILE);
  rmSync(socket, { force: true });
  const script = `#!/bin/sh\n# The vault's helper (hopper client, issue #558): written by the client at each start.\n${SOCKET_VARIABLE}=${quote(socket)} exec ${quote(o.node ?? process.execPath)} ${quote(join(o.installDir, 'secret.ts'))} "$@"\n`;
  writeFileSync(`${helper}.tmp`, script, { mode: 0o700 });
  renameSync(`${helper}.tmp`, helper);

  const server = createServer((conn) => {
    let text = '';
    const reply = (payload: { value: string } | { error: string }): void => { conn.end(`${JSON.stringify(payload)}\n`); };
    conn.setEncoding('utf8');
    conn.on('error', () => conn.destroy());
    conn.on('data', (chunk: string) => {
      text += chunk;
      if (text.length > MAX_ASK) { reply({ error: 'the ask is too long' }); return; }
      const end = text.indexOf('\n');
      if (end < 0) return;
      conn.removeAllListeners('data');
      let parsed: unknown;
      try { parsed = JSON.parse(text.slice(0, end)); } catch { return reply({ error: 'the ask must be a line of JSON' }); }
      const ask = askOf(parsed);
      if (typeof ask === 'string') return reply({ error: ask });
      o.ask(ask).then((value) => reply({ value }), (e: unknown) => {
        o.log?.(`hopper-client: vault: ${askInWords(ask)}: ${(e as Error).message}`);
        reply({ error: (e as Error).message });
      });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socket, () => {
      chmodSync(socket, 0o600);
      resolve({
        socket, helper,
        stop: () => new Promise((done) => { server.close(() => done()); rmSync(socket, { force: true }); }),
      });
    });
  });
}
