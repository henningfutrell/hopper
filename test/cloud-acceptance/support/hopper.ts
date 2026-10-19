// The hopper of the cloud acceptance tests (issue #1956): the real composition root, with moto reset and seeded, the
// policy-assert proxy in front of it, and the minting credential AWS_LAB for the seed's account, which mints through
// the proxy. A box of the read template infra-read, joined, and a job at work on it, gets its read session from the
// client's vault helper, as a box's job does. Shared by the suite's test files.
import { join } from 'node:path';
import { expect } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../../support/app.ts';
import { startPolicyAssertProxy, type PolicyAssertProxy } from '../../support/policy-assert-proxy.ts';
import { boxes, helper, runningJob } from '../../support/vault-box.ts';
import { KEY } from '../../support/webhooks.ts';
import type { AwsKeys } from './aws-cli.ts';
import { ACCOUNT, REGION, resetMoto, seed, SEED_KEYS, type Seeded } from './moto.ts';

export const MINTING = { AccessKeyId: 'AKIAMINTINGACCEPT', SecretAccessKey: 'minting-secret-never-on-the-box' };
export const SESSION_NAME = 'hopper-acceptance';
export const BOX = 'hopper-sandbox-infra-read';
export const TEMPLATE = 'infra-read';

export interface Booted { a: TestApp; session: string; seeded: Seeded; proxy: PolicyAssertProxy }
export type ReadSession = { dir: string; job: string; keys: AwsKeys & { Expiration: string }; mintedAt: number };

/** What a test file boots, all ended by `end` (its afterEach). */
export function cloudHopper() {
  const box = boxes();
  let t: TestApp | undefined;
  let proxy: PolicyAssertProxy | undefined;
  const cleanups: (() => void)[] = [];
  return {
    box,
    async end(): Promise<void> {
      await box.end();
      await t?.stop();
      t = undefined;
      await proxy?.close();
      proxy = undefined;
      for (const c of cleanups.splice(0)) c();
    },
    /**
     * moto reset and seeded, the proxy in front of it (its clock `now`, when given), and a hopper whose AWS_LAB mints
     * through the proxy, with the template infra-read approved: read on the seed's read role. `env`: more of the daemon's
     * environment (a fake GitHub's, for the write path).
     */
    async boot(motoUrl: string, o: { now?: () => Date; env?: Record<string, string> } = {}): Promise<Booted> {
      await resetMoto(motoUrl);
      proxy = await startPolicyAssertProxy({ upstream: motoUrl, admins: [SEED_KEYS.accessKeyId, MINTING.AccessKeyId], ...(o.now ? { now: o.now } : {}) });
      const seeded = await seed(proxy.url);
      const db = tempDbPath();
      cleanups.push(db.cleanup);
      process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
      process.env.FAKE_HERDR_RUNNING = '1';
      t = await startTestApp({
        dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, ...(o.env ? { env: o.env } : {}),
        plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
      });
      const session = await t.login();
      const edit = async (body: Record<string, unknown>) => expect((await t!.ui('/ui/api/vault', body, { token: session })).status).toBe(200);
      await edit({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ ...MINTING, Region: REGION, Endpoint: proxy.url, SessionName: SESSION_NAME }) });
      await edit({ action: 'save-template', name: TEMPLATE, image: 'localhost/box-aws:1', secrets: [], profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/read` } }] });
      await edit({ action: 'approve-template', name: TEMPLATE });
      return { a: t, session, seeded, proxy };
    },
    /** A box of infra-read with a job at work on it, and the read session its helper hands the job. */
    async readSession(a: TestApp, session: string): Promise<ReadSession> {
      const dir = await box.join(a, session, BOX, TEMPLATE);
      const job = await runningJob(a, BOX);
      const mintedAt = Date.now();
      const out = await mint(a, dir, job);
      expect(out.stderr).toBe('');
      expect(out.code).toBe(0);
      return { dir, job, keys: JSON.parse(out.stdout) as ReadSession['keys'], mintedAt };
    },
    /** The job's helper asks again for the read session: a renewal. */
    mint: (a: TestApp, dir: string, job: string) => mint(a, dir, job),
  };

  function mint(a: TestApp, dir: string, job: string) {
    return helper(dir, ['aws', 'read', `aws-role/${ACCOUNT}/read`], box.tokenFileOf(a, job));
  }
}
