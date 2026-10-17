// Issue #781, part 2, through the real composition root, the real HTTP server, the real operator CLI and the real minting
// adapters (STS faked on loopback): a person tests an AWS minting credential. The hopper mints a read session from it, as
// it mints one for a job, and asks STS `GetCallerIdentity` with that session. The answer shows the role the session
// assumed and the session name. The minting credential and the minted session never leave the hopper.
//
// Feature: a mint test shows the role a minted AWS session assumes
//   Scenario: the mint test answers the assumed role and the session name, never a key
//     Given the minting credential AWS_LAB for aws-account/123456789012, with the session name p2zapwin
//     When the operator runs `hopper vault mint-test aws-role/123456789012/diag`
//     Then STS gets AssumeRole on the role diag with RoleSessionName p2zapwin, 900 s and the ReadOnlyAccess policy
//     And STS gets GetCallerIdentity signed with the minted session
//     And the answer is the assumed role's ARN, its account and the session name
//     And `vault.mint_tested` records it, and no key is in the answer, the events or the log
//   Scenario: with the vault in a container of its own (issue #586), the vault mints and asks STS
//   Scenario: STS refuses AssumeRole: the test says why, and GetCallerIdentity is not asked
//   Scenario: no minting credential for the account, or an asset that is not an aws-role or a cluster: refused, STS not asked
//   Scenario: several minting credentials for the account (issue #1761): refused, every one named, STS not asked
//   Scenario: an aws-account minting credential whose value is not its JSON (issue #1761): not saved, the shape said
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { KEY } from '../support/webhooks.ts';

const ACCOUNT = '123456789012';
const MINTING_SECRET = 'minting-secret-key-fedcba-never-shown';
const MINTED_SECRET = 'minted-secret-never-shown';
const MINTED_SESSION = 'minted-session-token-never-shown';
const EXPIRES = '2030-01-01T00:15:00Z';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
let logged: string[] = [];

beforeEach(() => {
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
  }
});

afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  vi.restoreAllMocks();
});

interface Seen { action: string; params: URLSearchParams; authorization: string }

/**
 * STS on loopback, in the query protocol: AssumeRole answers a session (or `refuse` it), and GetCallerIdentity answers
 * the role that session assumed, named with the session name AssumeRole got.
 */
async function fakeSts(o: { refuse?: boolean } = {}): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  let sessionName = '';
  const server: Server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const action = params.get('Action') ?? '';
      seen.push({ action, params, authorization: req.headers.authorization ?? '' });
      const xml = (s: number, x: string) => res.writeHead(s, { 'content-type': 'text/xml' }).end(x);
      if (action === 'AssumeRole' && o.refuse) {
        return xml(403, '<ErrorResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><Error><Type>Sender</Type><Code>AccessDenied</Code><Message>User is not authorized to perform: sts:AssumeRole</Message></Error><RequestId>r0</RequestId></ErrorResponse>');
      }
      if (action === 'AssumeRole') {
        sessionName = params.get('RoleSessionName') ?? '';
        return xml(200, `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><AssumeRoleResult><Credentials><AccessKeyId>ASIAMINTED</AccessKeyId><SecretAccessKey>${MINTED_SECRET}</SecretAccessKey><SessionToken>${MINTED_SESSION}</SessionToken><Expiration>${EXPIRES}</Expiration></Credentials><AssumedRoleUser><Arn>arn:aws:sts::${ACCOUNT}:assumed-role/diag/${sessionName}</Arn><AssumedRoleId>AROADIAG:${sessionName}</AssumedRoleId></AssumedRoleUser></AssumeRoleResult><ResponseMetadata><RequestId>r1</RequestId></ResponseMetadata></AssumeRoleResponse>`);
      }
      return xml(200, `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/"><GetCallerIdentityResult><Arn>arn:aws:sts::${ACCOUNT}:assumed-role/diag/${sessionName}</Arn><UserId>AROADIAG:${sessionName}</UserId><Account>${ACCOUNT}</Account></GetCallerIdentityResult><ResponseMetadata><RequestId>r2</RequestId></ResponseMetadata></GetCallerIdentityResponse>`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => { server.close(); });
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

async function boot(o: { container?: boolean; refuse?: boolean } = {}): Promise<{ a: TestApp; sts: Awaited<ReturnType<typeof fakeSts>> }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const sts = await fakeSts(o);
  const vault = o.container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
  if (vault) cleanups.push(() => { void vault.stop(); });
  const keys = vault ? { secrets: { HOPPER_MASTER_KEY: KEY, HOPPER_VAULT_KEY: VAULT_KEY }, env: { HOPPER_VAULT_URL: vault.url } } : { secrets: { HOPPER_MASTER_KEY: KEY } };
  t = await startTestApp({ dbPath: db.dbPath, ...keys, plugins: { machines: lanes(1) }, seams: { authorizationServer: createFakeAuthorizationServer() } });
  const value = { AccessKeyId: 'AKIAMINTING', SecretAccessKey: MINTING_SECRET, Region: 'us-east-1', Endpoint: sts.url, SessionName: 'p2zapwin' };
  const session = await t.login();
  expect((await t.ui('/ui/api/vault', { action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify(value) }, { token: session })).status).toBe(200);
  return { a: t, sts };
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

/** No key — the minting credential's or the minted session's — in what the CLI printed, the events or the log. */
function noKeyAnywhere(a: TestApp, printed: string): void {
  const everything = [printed, JSON.stringify(a.user().store.events.since(0, 100_000)), logged.join('\n')].join('\n');
  for (const secret of [MINTING_SECRET, MINTED_SECRET, MINTED_SESSION, 'ASIAMINTED']) expect(everything).not.toContain(secret);
}

const testedEvents = (a: TestApp) => a.user().store.events.since(0, 100_000).filter((e) => e.type === 'vault.mint_tested');

describe('a mint test shows the role a minted AWS session assumes (issue #781)', () => {
  it('answers the assumed role and the session name; STS got 900 s, the read-only policy and the minted session', async () => {
    const { a, sts } = await boot();
    const r = await hopper(a, ['vault', 'mint-test', `aws-role/${ACCOUNT}/diag`]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({
      kind: 'aws', asset: { kind: 'aws-role', name: `${ACCOUNT}/diag` }, credential: 'AWS_LAB', roleArn: `arn:aws:iam::${ACCOUNT}:role/diag`,
      sessionName: 'p2zapwin', durationSeconds: 900, policyArns: ['arn:aws:iam::aws:policy/ReadOnlyAccess'], expiresAt: '2030-01-01T00:15:00.000Z',
      identity: { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/diag/p2zapwin`, account: ACCOUNT, userId: 'AROADIAG:p2zapwin' },
    });
    expect(sts.seen.map((s) => s.action)).toEqual(['AssumeRole', 'GetCallerIdentity']);
    const assume = sts.seen[0]!.params;
    expect(assume.get('RoleArn')).toBe(`arn:aws:iam::${ACCOUNT}:role/diag`);
    expect(assume.get('RoleSessionName')).toBe('p2zapwin');
    expect(assume.get('DurationSeconds')).toBe('900');
    expect(assume.get('PolicyArns.member.1.arn')).toBe('arn:aws:iam::aws:policy/ReadOnlyAccess');
    expect(sts.seen[0]!.authorization).toContain('Credential=AKIAMINTING/');
    expect(sts.seen[1]!.authorization).toContain('Credential=ASIAMINTED/');
    expect(testedEvents(a)).toEqual([expect.objectContaining({
      data: expect.objectContaining({ asset: { kind: 'aws-role', name: `${ACCOUNT}/diag` }, credential: 'AWS_LAB', sessionName: 'p2zapwin', arn: `arn:aws:sts::${ACCOUNT}:assumed-role/diag/p2zapwin` }),
    })]);
    noKeyAnywhere(a, r.out);
  });

  it('with the vault in a container of its own, the vault mints and asks STS', async () => {
    const { a, sts } = await boot({ container: true });
    const r = await hopper(a, ['vault', 'mint-test', `aws-role/${ACCOUNT}/diag`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ sessionName: 'p2zapwin', identity: { arn: `arn:aws:sts::${ACCOUNT}:assumed-role/diag/p2zapwin` } });
    expect(sts.seen.map((s) => s.action)).toEqual(['AssumeRole', 'GetCallerIdentity']);
    noKeyAnywhere(a, r.out);
  });

  it('says why when STS refuses AssumeRole, and asks no GetCallerIdentity', async () => {
    const { a, sts } = await boot({ refuse: true });
    const r = await hopper(a, ['vault', 'mint-test', `aws-role/${ACCOUNT}/diag`]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/STS refused AssumeRole on arn:aws:iam::123456789012:role\/diag: User is not authorized/);
    // Which secret the test used (issue #1761).
    expect(r.err).toContain('AWS_LAB');
    expect(sts.seen.map((s) => s.action)).toEqual(['AssumeRole']);
    expect(testedEvents(a)).toEqual([expect.objectContaining({ data: expect.objectContaining({ credential: 'AWS_LAB', reason: expect.stringMatching(/STS refused/) }) })]);
    noKeyAnywhere(a, r.err);
  });

  it('refuses an account no minting credential mints for, and an asset that is not an aws-role or a cluster; STS is not asked', async () => {
    const { a, sts } = await boot();
    const other = await hopper(a, ['vault', 'mint-test', 'aws-role/999999999999/diag']);
    expect(other.code).toBe(2);
    expect(other.err).toMatch(/no minting credential mints for aws-account 999999999999/);
    const namespace = await hopper(a, ['vault', 'mint-test', 'namespace/lab/web']);
    expect(namespace.code).toBe(2);
    expect(namespace.err).toMatch(/aws-role/);
    expect((await hopper(a, ['vault', 'mint-test'])).err).toMatch(/usage: hopper vault mint-test/);
    expect(sts.seen).toEqual([]);
  });

  it('refuses when several minting credentials mint for the account, and names them all; STS is not asked (issue #1761)', async () => {
    const { a, sts } = await boot();
    const session = await a.login();
    const value = JSON.stringify({ AccessKeyId: 'AKIAOTHER', SecretAccessKey: 'other-secret-0123456789' });
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'AWS_NEW', mints: { kind: 'aws-account', name: ACCOUNT }, value }, { token: session })).status).toBe(200);
    const r = await hopper(a, ['vault', 'mint-test', `aws-role/${ACCOUNT}/diag`]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`2 minting credentials mint for aws-account ${ACCOUNT}: AWS_LAB, AWS_NEW`);
    expect(sts.seen).toEqual([]);
  });

  it('keeps no aws-account minting credential whose value is not JSON with AccessKeyId and SecretAccessKey (issue #1761)', async () => {
    const { a } = await boot();
    const session = await a.login();
    const set = (value: string) => a.ui('/ui/api/vault', { action: 'set', name: 'AWS_KEY_ID', mints: { kind: 'aws-account', name: ACCOUNT }, value }, { token: session });
    const half = await set('AKIAHALFOFIT');
    expect(half.status).toBe(400);
    expect(JSON.stringify(half.body)).toContain('AccessKeyId and SecretAccessKey');
    expect(JSON.stringify(half.body)).not.toContain('AKIAHALFOFIT');
    expect((await set(JSON.stringify({ AccessKeyId: 'AKIAHALFOFIT' }))).status).toBe(400);
    expect(a.user().store.vault.get('AWS_KEY_ID')).toBeUndefined();
  });
});
