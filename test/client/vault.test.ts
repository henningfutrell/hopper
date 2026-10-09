// Issue #558: a job on a joined machine gets a vault secret just in time, never from its environment or a
// file. The machine's client serves a local socket (mode 600) and writes the `hopper-secret` helper; the
// helper asks the client showing the job's proxy token (issue #563), the client asks the hopper with a request
// signed by the machine's link, and the
// hopper's answer is sealed to that one request under the client token, so the value crosses no wire in
// clear and is never written to the machine's disk (design.md "The vault").
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNonceCache, mintToken, nonceOf, signRequest, signVault, verifyRequest, verifyVault } from '../../src/client/signature.ts';
import { isSecretName, openAnswer, sealAnswer, startVault, type Vault, type VaultAsk } from '../../src/client/vault.ts';
import { credentialOutput } from '../../src/client/secret.ts';

const TOKEN = mintToken();
const JOB_TOKEN = 'dTE.job-1.bWFjLW9mLWpvYi0x';
const ASK: VaultAsk = { name: 'DEPLOY_KEY', token: JOB_TOKEN };
const BODY = JSON.stringify(ASK);
const T0 = 1_800_000_000_000;
const INSTALL = join(process.cwd(), 'src/client');

describe('a vault request', () => {
  it('is signed by the machine over its user, its key and the body, and verifies once', () => {
    const seen = createNonceCache();
    const h = signVault(TOKEN, 'u1', 'machine-key', BODY, T0);
    expect(h).not.toContain(TOKEN);
    expect(verifyVault(TOKEN, h, 'u1', 'machine-key', BODY, seen, T0 + 1000)).toMatchObject({ ok: true });
    expect(verifyVault(TOKEN, h, 'u1', 'machine-key', BODY, seen, T0 + 1000)).toEqual({ ok: false, why: 'replayed' });
  });

  it('another body, user or machine key, or a stale one: refused', () => {
    const h = signVault(TOKEN, 'u1', 'machine-key', BODY, T0);
    expect(verifyVault(TOKEN, h, 'u1', 'machine-key', JSON.stringify({ ...ASK, name: 'OTHER' }), createNonceCache(), T0)).toEqual({ ok: false, why: 'bad signature' });
    expect(verifyVault(TOKEN, h, 'u2', 'machine-key', BODY, createNonceCache(), T0)).toEqual({ ok: false, why: 'bad signature' });
    expect(verifyVault(TOKEN, h, 'u1', 'other-key', BODY, createNonceCache(), T0)).toEqual({ ok: false, why: 'bad signature' });
    expect(verifyVault(TOKEN, h, 'u1', 'machine-key', BODY, createNonceCache(), T0 + 60_000)).toEqual({ ok: false, why: 'stale' });
    expect(verifyVault(TOKEN, undefined, 'u1', 'machine-key', BODY, createNonceCache(), T0)).toEqual({ ok: false, why: 'unsigned' });
  });

  it('is never taken for the hopper\'s request to the client, nor the other way round: its own label', () => {
    const vault = signVault(TOKEN, 'u1', 'machine-key', BODY, T0);
    expect(verifyRequest(TOKEN, vault, 'POST', '/client/vault', BODY, createNonceCache(), T0)).toEqual({ ok: false, why: 'bad signature' });
    const request = signRequest(TOKEN, 'POST', '/client/vault', BODY, T0);
    expect(verifyVault(TOKEN, request, 'u1', 'machine-key', BODY, createNonceCache(), T0)).toEqual({ ok: false, why: 'bad signature' });
  });
});

describe('a vault answer', () => {
  const nonce = nonceOf(signVault(TOKEN, 'u1', 'machine-key', BODY, T0));

  it('is sealed to the request under the client token: the value is not in it', () => {
    const a = sealAnswer(TOKEN, nonce, ASK, 's3cret-value');
    expect(JSON.stringify(a)).not.toContain('s3cret-value');
    expect(openAnswer(TOKEN, nonce, ASK, a)).toBe('s3cret-value');
    expect(JSON.stringify(sealAnswer(TOKEN, nonce, ASK, 's3cret-value'))).not.toBe(JSON.stringify(a));
  });

  it('opens only for its own request, secret, job token and client token', () => {
    const a = sealAnswer(TOKEN, nonce, ASK, 's3cret-value');
    const other = nonceOf(signVault(TOKEN, 'u1', 'machine-key', BODY, T0));
    expect(() => openAnswer(TOKEN, other, ASK, a)).toThrow(/cannot be opened/);
    expect(() => openAnswer(TOKEN, nonce, { ...ASK, name: 'OTHER' }, a)).toThrow(/cannot be opened/);
    expect(() => openAnswer(TOKEN, nonce, { ...ASK, token: 'dTE.job-2.bWFjLW9mLWpvYi0y' }, a)).toThrow(/cannot be opened/);
    expect(() => openAnswer(mintToken(), nonce, ASK, a)).toThrow(/cannot be opened/);
    expect(() => openAnswer(TOKEN, nonce, ASK, { salt: 'x' })).toThrow(/not a sealed answer/);
  });
});

describe('a secret name', () => {
  it('is a letter, then letters, digits, `_`, `.`, `-`, at most 64', () => {
    for (const n of ['A', 'DEPLOY_KEY', 'aws.prod-ro', 'k8s_token_2']) expect(isSecretName(n)).toBe(true);
    for (const n of ['', '1A', '-x', 'a b', 'a/b', '$X', 'x'.repeat(65), 7]) expect(isSecretName(n)).toBe(false);
  });
});

/** The job's proxy token, in a file of the job's as the hopper keeps it (issue #563). */
const tokenFile = (): string => { const f = join(mkdtempSync(join(tmpdir(), 'job-')), 'token'); writeFileSync(f, `${JOB_TOKEN}\n`, { mode: 0o600 }); return f; };

/** Runs the helper as a job runs it: with its token file, and nothing of the vault in its environment but the helper's own. */
function helper(v: Vault, args: string[], env: Record<string, string | undefined> = { HOPPER_TOKEN_FILE: tokenFile() }, input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(v.helper, args, { env: { PATH: process.env.PATH, ...env } as NodeJS.ProcessEnv, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

describe('the vault on a machine', () => {
  let vault: Vault | undefined;
  afterEach(async () => { await vault?.stop(); vault = undefined; });

  async function start(answer: (ask: VaultAsk) => Promise<string>): Promise<{ v: Vault; dir: string; asks: VaultAsk[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'vault-'));
    const asks: VaultAsk[] = [];
    vault = await startVault({ dir, installDir: INSTALL, ask: (a) => { asks.push(a); return answer(a); } });
    return { v: vault, dir, asks };
  }

  it('serves a socket only its user can open, and writes the helper beside it', async () => {
    const { v, dir } = await start(async () => 'x');
    expect(v.socket).toBe(join(dir, 'vault.sock'));
    expect(v.helper).toBe(join(dir, 'hopper-secret'));
    expect(statSync(v.socket).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(v.helper).mode & 0o777).toBe(0o700);
  });

  it('get: the helper prints the value the hopper gave for the job; nothing of it is written to disk', async () => {
    const { v, dir, asks } = await start(async () => 'value-from-the-hopper');
    const r = await helper(v, ['get', 'DEPLOY_KEY']);
    expect(r).toMatchObject({ code: 0, stdout: 'value-from-the-hopper' });
    expect(asks).toEqual([{ name: 'DEPLOY_KEY', token: JOB_TOKEN }]);
    for (const f of readdirSync(dir)) {
      if (f !== 'vault.sock') expect(readFileSync(join(dir, f), 'utf8')).not.toContain('value-from-the-hopper');
    }
  });

  it('outside a job (no HOPPER_TOKEN_FILE) nothing is asked', async () => {
    const { v, asks } = await start(async () => 'x');
    const r = await helper(v, ['get', 'DEPLOY_KEY'], {});
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/HOPPER_TOKEN_FILE/);
    expect(asks).toEqual([]);
  });

  it('a refusal is said as the hopper said it, with a non-zero exit', async () => {
    const { v } = await start(async () => { throw new Error('the hopper refused (403): this machine may not have DEPLOY_KEY'); });
    const r = await helper(v, ['get', 'DEPLOY_KEY']);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toMatch(/may not have DEPLOY_KEY/);
    expect(r.stdout).toBe('');
  });

  it('a name that is no secret name is refused before anything is asked', async () => {
    const { v, asks } = await start(async () => 'x');
    const r = await helper(v, ['get', '../etc']);
    expect(r.code).not.toBe(0);
    expect(asks).toEqual([]);
  });

  it('git: a credential helper that answers get with the value as the password', async () => {
    const { v } = await start(async () => 'ghs_token');
    expect(await helper(v, ['git', 'GH', 'get'], undefined, 'protocol=https\nhost=github.com\n\n')).toMatchObject({ code: 0, stdout: 'username=x-access-token\npassword=ghs_token\n' });
    expect(await helper(v, ['git', 'GH', 'deploy-bot', 'get'], undefined, 'protocol=https\n\n')).toMatchObject({ code: 0, stdout: 'username=deploy-bot\npassword=ghs_token\n' });
    // store and erase: git's to ask, the vault's to ignore
    expect(await helper(v, ['git', 'GH', 'store'], undefined, 'protocol=https\n\n')).toMatchObject({ code: 0, stdout: '' });
  });
});

describe('credential output', () => {
  it('aws: credential_process JSON from a secret holding the key pair', () => {
    const value = JSON.stringify({ AccessKeyId: 'AKIAEXAMPLE', SecretAccessKey: 'secret' });
    expect(JSON.parse(credentialOutput('aws', value))).toEqual({ Version: 1, AccessKeyId: 'AKIAEXAMPLE', SecretAccessKey: 'secret' });
    const session = JSON.stringify({ AccessKeyId: 'ASIA', SecretAccessKey: 's', SessionToken: 't', Expiration: '2026-10-09T00:00:00Z' });
    expect(JSON.parse(credentialOutput('aws', session))).toEqual({ Version: 1, AccessKeyId: 'ASIA', SecretAccessKey: 's', SessionToken: 't', Expiration: '2026-10-09T00:00:00Z' });
    expect(() => credentialOutput('aws', 'not json')).toThrow(/AccessKeyId and SecretAccessKey/);
  });

  it('kube: an ExecCredential carrying the token, in the API version kubectl asked for', () => {
    expect(JSON.parse(credentialOutput('kube', 'k8s-token'))).toEqual({ apiVersion: 'client.authentication.k8s.io/v1', kind: 'ExecCredential', status: { token: 'k8s-token' } });
    const info = JSON.stringify({ apiVersion: 'client.authentication.k8s.io/v1beta1', kind: 'ExecCredential', spec: {} });
    expect(JSON.parse(credentialOutput('kube', 'k8s-token', { KUBERNETES_EXEC_INFO: info })).apiVersion).toBe('client.authentication.k8s.io/v1beta1');
  });

  it('get: the value as it is', () => {
    expect(credentialOutput('get', 'a b\nc')).toBe('a b\nc');
  });
});
