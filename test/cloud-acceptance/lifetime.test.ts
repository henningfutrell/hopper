// Issue #1956 (acceptance criterion 3): a read session's lifetime, against a mock AWS (moto) behind the policy-assert
// proxy. The hopper mints nothing more for a job that ended, or for a template whose approval a person revoked in
// Access; the session the job already held is bounded by its own lifetime (900 s at most), after which AWS — here the
// proxy, whose clock the test moves — denies it. The hopper does not end an STS session early: a session STS issued
// lives until it expires (see the pull request of this part for the gap).
//
// Feature: a read session lives no longer than its job and its approval
//   Scenario: after the job ends
//     Given a job at work on a box of infra-read, which holds a read session
//     When the job is cancelled
//     Then its helper's renewal is refused, and STS is asked for no new session
//     And the session it held is denied once its lifetime is over
//   Scenario: after a revoke in Access
//     Given a job at work on a box of infra-read, which holds a read session
//     When a person revokes the template's read approval in Access
//     Then its helper's renewal is refused, Access saying why, and STS is asked for no new session
//     And the session it held is denied once its lifetime is over
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { AWS_SESSION_SECONDS } from '../../src/domain/minting.ts';
import type { AccessView } from '../../src/domain/access.ts';
import type { TestApp } from '../support/app.ts';
import type { PolicyAssertProxy } from '../support/policy-assert-proxy.ts';
import { aws, type AwsKeys } from './support/aws-cli.ts';
import { cloudHopper, TEMPLATE, type ReadSession } from './support/hopper.ts';
import { BUCKET, REGION, startMoto, type Moto } from './support/moto.ts';

let moto: Moto;
const h = cloudHopper();
/** The proxy's clock: now, or the time a test moved it to. */
const clock: { at?: Date } = {};

beforeAll(async () => { moto = await startMoto(); }, 180_000);
afterAll(async () => { await moto?.stop(); });
afterEach(async () => {
  delete clock.at;
  await h.end();
});

const boot = () => h.boot(moto.url, { now: () => clock.at ?? new Date() });

/** The session reads, who it is by the aws CLI and the buckets by the SDK: the CLI's exit code and output, the SDK's answer. */
async function reads(url: string, keys: AwsKeys): Promise<{ cli: number; who: string; sdk: string }> {
  const cli = await aws(url, keys, ['sts', 'get-caller-identity', '--output', 'json']);
  const s3 = new S3Client({ endpoint: url, region: REGION, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: keys.AccessKeyId, secretAccessKey: keys.SecretAccessKey, sessionToken: keys.SessionToken! } });
  try {
    return { cli: cli.code, who: `${cli.stdout}${cli.stderr}`, sdk: ((await s3.send(new ListBucketsCommand({}))).Buckets ?? []).map((b) => b.Name).join(',') };
  } catch (e) {
    return { cli: cli.code, who: `${cli.stdout}${cli.stderr}`, sdk: (e as Error).message };
  } finally {
    s3.destroy();
  }
}

/** The renewal is refused, `why`, and STS was asked for no session beside the first. */
async function renewalRefused(a: TestApp, proxy: PolicyAssertProxy, s: ReadSession, why: RegExp): Promise<void> {
  const renewal = await h.mint(a, s.dir, s.job);
  expect(renewal.code).not.toBe(0);
  expect(renewal.stdout).toBe('');
  expect(renewal.stderr).toMatch(why);
  expect([...proxy.sessions.keys()]).toEqual([s.keys.AccessKeyId]);
}

/** The session it held is allowed until its lifetime is over, then denied by the CLI and the SDK alike. */
async function deniedOnceExpired(proxy: PolicyAssertProxy, s: ReadSession): Promise<void> {
  expect(Date.parse(s.keys.Expiration) - s.mintedAt).toBeLessThanOrEqual(AWS_SESSION_SECONDS * 1000 + 5000);
  const live = await reads(proxy.url, s.keys);
  expect(live.cli, live.who).toBe(0);
  expect(live.who).toMatch(/assumed-role\/read\//);
  expect(live.sdk).toBe(BUCKET);
  clock.at = new Date(Date.parse(s.keys.Expiration) + 1000);
  const reached = proxy.log.length;
  const ended = await reads(proxy.url, s.keys);
  expect(ended.cli).not.toBe(0);
  expect(ended.who).toMatch(/AccessDenied/);
  expect(ended.sdk).toMatch(/policy-assert: the session expired/);
  const denied = proxy.log.slice(reached);
  expect(denied.length).toBeGreaterThanOrEqual(2);
  expect(denied.every((d) => !d.allowed && d.accessKeyId === s.keys.AccessKeyId && /expired/.test(d.reason)), JSON.stringify(denied)).toBe(true);
}

describe('a read session\'s lifetime against a mock AWS behind the policy-assert proxy (issue #1956)', () => {
  it('after the job ends: no renewal, and the session it held is denied once its lifetime is over', async () => {
    const { a, session, proxy } = await boot();
    const s = await h.readSession(a, session);
    expect((await a.ui(`/ui/api/jobs/${s.job}/cancel`, {}, { token: session })).status).toBe(200);
    await a.waitForStatus(s.job, 'cancelled', 10000);
    await renewalRefused(a, proxy, s, /not at work \(cancelled\)/);
    await deniedOnceExpired(proxy, s);
  }, 180_000);

  it('after a revoke in Access: no renewal, and the session it held is denied once its lifetime is over', async () => {
    const { a, session, proxy } = await boot();
    const s = await h.readSession(a, session);
    const view = (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body;
    const approval = view.templates.find((t) => t.template === TEMPLATE)!.approvals[0]!;
    expect(approval.profile).toMatchObject({ operation: 'read', asset: { kind: 'aws-role' } });
    expect((await a.ui('/ui/api/access', { action: 'revoke', approval: approval.id }, { token: session })).status).toBe(200);
    await renewalRefused(a, proxy, s, new RegExp(`${TEMPLATE} is not approved to read`));
    await deniedOnceExpired(proxy, s);
  }, 180_000);
});
