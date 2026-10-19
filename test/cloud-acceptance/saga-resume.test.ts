// Issue #1956 (acceptance criterion 6, saga resume): a job's need step on a real container runtime, against moto behind
// the policy-assert proxy, with the hopper killed mid-step. The hoppers are the crash harness's (test/crash/harness.ts):
// the real composition root in processes of their own over one database, each ended with SIGKILL at a kill point of the
// `need-step` saga or while the need box runs. The need box is a real container of the image the hopper makes for the
// template (the published box image with terraform and the aws CLI), on the host's network, so the box's aws CLI reaches
// the proxy with the session the vault minted for the step. A second hopper on the same database ends the step. Not part
// of `npm test`: `npm run test:cloud` (vitest.cloud.config.ts).
//
// Feature: a need step outlives its hopper, and runs once
//   Scenario Outline: the hopper is killed <when>; a second hopper ends the step
//     Given a job at work whose step needs a read session of the seed's read role, on a template that covers it
//     When the first hopper is killed <when>
//     And a second hopper starts on the same database
//     Then the step's saga ends once, and the job reads one result: <result>
//     And the step's command reached moto once: one read of the state object's head, by a session STS minted once
//     And no need box and no home volume is left at the runtime
//     And every session minted for the step is denied once its lifetime is over (the hopper ends no STS session early)
//     Examples: before the mint (its exit 0) | after the mint, while the command runs (not run again: STEP_INTERRUPTED)
//       | after the box exited, before the saga recorded it (its exit 0) | before and after the credentials' release (its exit 0)
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ListBucketsCommand, S3Client } from '@aws-sdk/client-s3';
import { AWS_SESSION_SECONDS } from '../../src/domain/minting.ts';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { NEED_STEP_SAGA } from '../../src/sandbox/need-step-saga.ts';
import { STEP_INTERRUPTED } from '../../src/sandbox/need-steps.ts';
import { STEP_HEADER, STEP_PATH } from '../../src/windows-steps/script.ts';
import { openDb } from '../../src/store/db.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { startPolicyAssertProxy, type PolicyAssertProxy } from '../support/policy-assert-proxy.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, startHost, stopHosts, type CrashHost } from '../crash/harness.ts';
import { asJob, keptStep, needSagas } from '../crash/need-world.ts';
import { BOX_BASE, cli, runtimeSocket, writeBoxImage } from './support/box.ts';
import { MINTING, SESSION_NAME } from './support/hopper.ts';
import { ACCOUNT, BUCKET, READ_ROLE, REGION, resetMoto, seed, SEED_KEYS, startMoto, STATE_KEY, type Moto } from './support/moto.ts';

const REPO = 'octo/infra';
const TEMPLATE = 'infra-step';
const NEED = `read/aws-role/${ACCOUNT}/read`;
/** The job's key for its ask: the same ask sent again is the same step. */
const KEY = 'acceptance-saga-0001';
/** The step command's own call, as the proxy logs it: a HEAD of the state object, which nothing else asks. */
const MARK = { method: 'HEAD', path: `/${BUCKET}/${STATE_KEY}` };
/** The most one scenario takes: the need box's image is built already; two hoppers start, one is killed. */
const SCENARIO_MS = 300_000;

let moto: Moto;
const clock: { at?: Date } = {};
let world: { proxy: PolicyAssertProxy; github: FakeForge; url: string; cleanup(): void } | undefined;

beforeAll(async () => {
  moto = await startMoto();
  // The image the hopper makes for the template, built once: a hopper builds it again only when it is missing.
  await writeBoxImage();
}, 1_200_000);
afterAll(async () => { await moto?.stop(); });
afterEach(async () => {
  await stopHosts();
  delete clock.at;
  // A box a failed scenario left: no later world's sweep burns it, as it is another instance's.
  if (world) for (const id of await leftAtRuntime(world.url)) await cli(['rm', '-f', '-t', '0', id]).then((r) => (r.code === 0 ? r : cli(['volume', 'rm', '-f', id])));
  await world?.proxy.close();
  await world?.github.close();
  world?.cleanup();
  world = undefined;
});

const point = (step: string, at: 'before-do' | 'after-do'): string => sagaKillPoint(NEED_STEP_SAGA, step, at);

/** moto reset and seeded behind a new proxy, a fresh database, and the fake GitHub with the job's issue. */
async function setUpWorld(): Promise<{ proxy: PolicyAssertProxy; url: string; host(o?: { killPoint?: string; job?: boolean }): Promise<CrashHost> }> {
  await resetMoto(moto.url);
  const proxy = await startPolicyAssertProxy({ upstream: moto.url, admins: [SEED_KEYS.accessKeyId, MINTING.AccessKeyId], now: () => clock.at ?? new Date() });
  await seed(proxy.url);
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Read the account', body: 'Please.', author: 'owner', labels: [] });
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  world = { proxy, github, url, cleanup: db.cleanup };
  return {
    proxy, url,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, ...runtimeSocket(),
      ...(h.job ? { connectGitHub: [REPO], job: `${REPO}#7` } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
  };
}

/** A person keeps the minting credential (STS through the proxy) and saves and approves the template, which reads the seed's read role. */
async function setUp(h: CrashHost, proxyUrl: string): Promise<void> {
  const vault = async (body: Record<string, unknown>) => { const r = await h.ui('/ui/api/vault', body); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  await vault({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ ...MINTING, Region: REGION, Endpoint: proxyUrl, SessionName: SESSION_NAME }) });
  await vault({ action: 'save-template', name: TEMPLATE, image: BOX_BASE, tools: ['terraform', 'aws'], secrets: [], profiles: [{ operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/read` } }] });
  await vault({ action: 'approve-template', name: TEMPLATE });
}

/** The step's command: the box's aws CLI reads the state object's head, then lists the bucket; `hang`, then it runs on until it is stopped. */
const command = (proxyUrl: string, hang: boolean): string => {
  const aws = `aws --no-cli-pager --endpoint-url ${proxyUrl} s3api`;
  return `${aws} head-object --bucket ${BUCKET} --key ${STATE_KEY} >/dev/null && ${aws} list-objects-v2 --bucket ${BUCKET} --query 'Contents[].Key' --output text${hang ? ' && sleep 600' : ''}`;
};

const ask = (h: CrashHost, proxyToken: string, cmd: string) =>
  asJob(h, proxyToken, 'POST', `${STEP_PATH}?${new URLSearchParams({ needs: NEED, key: KEY, command: cmd, timeout: '900' }).toString()}`);

/** The sessions STS minted for the read role, through the proxy. */
const stepSessions = (proxy: PolicyAssertProxy) => [...proxy.sessions.values()].filter((s) => s.roleArn === READ_ROLE);
/** The step command's own calls: the ones with its mark, by a session of the read role. */
const marked = (proxy: PolicyAssertProxy) => {
  const keys = new Set(stepSessions(proxy).map((s) => s.accessKeyId));
  return proxy.log.filter((d) => d.accessKeyId !== undefined && keys.has(d.accessKeyId) && d.method === MARK.method && d.path === MARK.path);
};

/** The instance id the hoppers on the database at `url` share: their need boxes carry it. */
function instanceOf(url: string): string | undefined {
  const db = openDb(url);
  try { return (db.get('SELECT value FROM settings WHERE key = ?', 'instanceId') as { value: string } | undefined)?.value; } finally { db.close(); }
}

/** The need boxes and their home volumes of the hoppers on the database at `url` that the runtime still holds. */
async function leftAtRuntime(url: string): Promise<string[]> {
  const instance = instanceOf(url);
  if (!instance) return [];
  const label = `label=${NEED_LABEL}=${instance}`;
  const boxes = (await cli(['ps', '-a', '-q', '--filter', label])).stdout.split('\n').filter(Boolean);
  const homes = (await cli(['volume', 'ls', '-q', '--filter', label])).stdout.split('\n').filter(Boolean);
  return [...boxes, ...homes];
}

interface Ended { exit: number; problem: string | undefined; saga: string; log: string }

/**
 * The scenario: a first hopper, whose job asks for the step, killed at `kill` (a kill point), or, with none, while the
 * need box runs, after its command listed the bucket. A second hopper ends the step's saga. What the job reads then.
 */
async function killedThenEnded(kill?: string): Promise<Ended> {
  const w = await setUpWorld();
  const a = await w.host({ job: true, ...(kill ? { killPoint: kill } : {}) });
  const job = a.job!;
  await setUp(a, w.proxy.url);
  const asked = await ask(a, job.proxyToken, command(w.proxy.url, kill === undefined));
  if (kill) await killedAt(a, kill);
  else {
    expect(asked.status, asked.text).toBe(202);
    await waitFor(() => (marked(w.proxy).length > 0 ? true : undefined), { timeoutMs: 120_000, intervalMs: 250, what: 'the step\'s command to read the state object' });
    await a.kill();
  }
  endLeases(w.url);
  const b = await w.host();
  const ended = await waitFor(() => {
    const sagas = needSagas(w.url);
    return sagas.length === 1 && (sagas[0]!.state === 'done' || sagas[0]!.state === 'compensated') ? sagas[0]! : undefined;
  }, { timeoutMs: 180_000, intervalMs: 250, what: 'the second hopper to end the step\'s saga' });
  const step = keptStep(w.url);
  expect(ended.key).toBe(step);

  // The job's ask sent again is the same step; the job reads its one result and its log.
  expect(String((await ask(b, job.proxyToken, command(w.proxy.url, false))).headers[STEP_HEADER.id])).toBe(step);
  const result = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${step}`);
  expect(result.status, result.text).toBe(200);
  const log = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${step}/log?from=0`);
  expect(log.status, log.text).toBe(200);
  const seen = `${JSON.stringify(result.headers)}
${log.text}`;
  // The step ran once: one mint, one read of the state object's head.
  expect(stepSessions(w.proxy), seen).toHaveLength(1);
  expect(marked(w.proxy), seen).toHaveLength(1);
  expect(marked(w.proxy)[0]).toMatchObject({ allowed: true, action: 's3:GetObject', status: 200 });
  // The box a killed host left is burned by the next host's sandbox sweep, at its start.
  await waitFor(async () => ((await leftAtRuntime(w.url)).length === 0 ? true : undefined), { timeoutMs: 60_000, intervalMs: 500, what: 'no need box or home left at the runtime' });

  expect(stepSessions(w.proxy)).toHaveLength(1);
  expect(marked(w.proxy)).toHaveLength(1);

  await deniedOnceExpired(w.proxy);
  const problem = result.headers[STEP_HEADER.problem];
  return { exit: Number(result.headers[STEP_HEADER.exit]), problem: typeof problem === 'string' ? problem : undefined, saga: ended.state, log: log.text };
}

/** Each session minted for the step lives no longer than AWS_SESSION_SECONDS, and once that is over the proxy denies it. */
async function deniedOnceExpired(proxy: PolicyAssertProxy): Promise<void> {
  for (const s of stepSessions(proxy)) {
    expect(s.durationSeconds).toBeLessThanOrEqual(AWS_SESSION_SECONDS);
    clock.at = new Date(Date.parse(s.expiration) + 1000);
    // The proxy checks no signature: the session's key id is what it judges.
    const s3 = new S3Client({ endpoint: proxy.url, region: REGION, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: s.accessKeyId, secretAccessKey: 'not-checked', sessionToken: 'not-checked' } });
    try {
      await expect(s3.send(new ListBucketsCommand({}))).rejects.toThrow(/policy-assert: the session expired/);
    } finally { s3.destroy(); }
  }
}

describe('a need step on a real runtime against a mock AWS, its hopper killed mid-step (issue #1956, criterion 6)', () => {
  const SCENARIOS: { when: string; kill?: string; interrupted?: boolean }[] = [
    { when: 'before the mint', kill: point('run', 'before-do') },
    { when: 'after the mint, while the step\'s command runs', interrupted: true },
    { when: 'after the box exited, before the saga recorded it', kill: point('run', 'after-do') },
    { when: 'before the credentials\' release', kill: point('release', 'before-do') },
    { when: 'after the credentials\' release', kill: point('release', 'after-do') },
  ];
  for (const s of SCENARIOS) {
    it(`killed ${s.when}: a second hopper ends the step once; the command reached moto once; nothing is left`, async () => {
      const ended = await killedThenEnded(s.kill);
      expect(ended.saga).toBe('done');
      if (s.interrupted) expect({ exit: ended.exit, problem: ended.problem }).toEqual({ exit: 125, problem: STEP_INTERRUPTED });
      else {
        expect({ exit: ended.exit, problem: ended.problem }, ended.log).toEqual({ exit: 0, problem: undefined });
        expect(ended.log).toContain(STATE_KEY);
      }
    }, SCENARIO_MS);
  }
});
