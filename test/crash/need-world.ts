// A need step (issues #1007, #1568, design.md "Need steps") under the crash harness (issue #1954): a first hopper runs a
// job of issue #7, which asks for a step that needs an AWS role and a cluster; the hopper is killed at a kill point of the
// `need-step` saga, or while the need box runs, or while it compensates a step the job stopped. A second hopper on the
// same database ends the saga. The container runtime is the libpod double (test/support/fake-libpod.ts) on a socket of
// the test process, reached through the real Podman adapter; STS and the Kubernetes API are the loopback fakes of
// test/support/fake-mint-apis.ts. So the boxes, their homes and the Secrets a minted token is bound to outlive a host.
import { expect } from 'vitest';
import type { OperationProfile } from '../../src/domain/access.ts';
import { sagaKillPoint } from '../../src/sagas/kill-points.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { NEED_STEP_SAGA } from '../../src/sandbox/need-step-saga.ts';
import { openDb } from '../../src/store/db.ts';
import { STEP_HEADER, STEP_PATH } from '../../src/windows-steps/script.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { createFakeGitHub, type FakeForge } from '../support/fake-forges.ts';
import { createFakeLibpod, type FakeLibpod } from '../support/fake-libpod.ts';
import { fakeKubeApi, fakeSts, MINTED_AWS, MINTED_KUBE_TOKEN, type FakeApi } from '../support/fake-mint-apis.ts';
import { startFakeRuntimeApi, type FakeRuntimeApi, type Handler } from '../support/fake-runtime-api.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { rawRequest } from '../support/http.ts';
import { waitFor } from '../support/wait.ts';
import { endLeases, killedAt, startHost, type CrashHost } from './harness.ts';

const REPO = 'octo/tools';
const ACCOUNT = '123456789012';
const TEMPLATE = 'dig';
const PROFILES: OperationProfile[] = [
  { operation: 'read', asset: { kind: 'aws-role', name: `${ACCOUNT}/readonly` } },
  { operation: 'read', asset: { kind: 'cluster', name: 'lab' } },
];
const NEEDS = PROFILES.map((p) => `${p.operation}/${p.asset.kind}/${p.asset.name}`).join(' ');
const MINTING_SECRET = 'crash-need-minting-secret-never-shown';
const KUBE_MINTING_TOKEN = 'crash-need-kube-minting-token-never-shown';
/** The job's key for its ask: the same each time the same step is asked. */
const KEY = 'crash-need-0001';
/** The most one scenario takes: two hoppers start, one is killed. */
export const SCENARIO_MS = 120_000;

const point = (step: string, at: 'before-do' | 'after-do' | 'before-compensate' | 'after-compensate'): string => sagaKillPoint(NEED_STEP_SAGA, step, at);
/** The kill points of the saga's steps: before and after `run` and `release`. */
export const NEED_STEP_KILL_POINTS: string[] = ['run', 'release'].flatMap((s) => [point(s, 'before-do'), point(s, 'after-do')]);
/** The kill points of the compensation of `run`, which a step the job stops passes. */
export const NEED_COMPENSATION_KILL_POINTS: string[] = [point('run', 'before-compensate'), point('run', 'after-compensate')];

export interface NeedWorld {
  url: string;
  libpod: FakeLibpod;
  runtime: FakeRuntimeApi;
  sts: FakeApi;
  kubeApi: FakeApi;
  github: FakeForge;
  /** A host; `job`: it pulls the job of #7 (the first host of a test). */
  host(o?: { killPoint?: string; job?: boolean }): Promise<CrashHost>;
  close(): Promise<void>;
}

/** The need box's command, as its create gave it. */
const commandOf = (body: Record<string, unknown>): string => String((body.env as Record<string, string> | undefined)?.HOPPER_STEP_COMMAND ?? '');

/**
 * A need box whose command says `hang` runs until it is stopped or removed: the libpod double answers its wait only
 * then, as Podman does. Every other box ends at once, exit 0.
 */
function hanging(libpod: FakeLibpod): Handler {
  return (r) => {
    const m = /\/containers\/([^/]+)\/wait$/.exec(r.path);
    if (r.method !== 'POST' || !m) return undefined;
    const c = libpod.containers.get(decodeURIComponent(m[1]!)) ?? [...libpod.containers.values()].find((x) => x.name === decodeURIComponent(m[1]!));
    if (!c || !commandOf(c.body).includes('hang')) return undefined;
    const after = waitFor(() => (libpod.containers.get(c.id)?.state !== 'running' ? true : undefined), { timeoutMs: SCENARIO_MS, intervalMs: 50 }).catch(() => undefined);
    return { status: 200, text: '137', after };
  };
}

/** A fresh database, the fake GitHub with octo/tools and its issue #7, the libpod double, STS and the Kubernetes API. */
export async function needWorld(): Promise<NeedWorld> {
  const github = await createFakeGitHub({ clientId: 'gh-client-id' });
  github.tokens.set(TEST_ACCOUNT_TOKEN, 'owner');
  github.issues.push({ repo: REPO, number: 7, title: 'Read the lab', body: 'Please.', author: 'owner', labels: [] });
  const libpod = createFakeLibpod();
  const runtime = await startFakeRuntimeApi([hanging(libpod), ...libpod.handlers]);
  const sts = await fakeSts(ACCOUNT);
  const kubeApi = await fakeKubeApi();
  const db = tempDbPath();
  const url = databaseUrlFor(db.dbPath);
  return {
    url, libpod, runtime, sts, kubeApi, github,
    host: (h = {}) => startHost({
      dbPath: db.dbPath, databaseUrl: url, fakes: { github: github.url }, podman: runtime.socket,
      ...(h.job ? { connectGitHub: [REPO], job: `${REPO}#7` } : {}), ...(h.killPoint ? { killPoint: h.killPoint } : {}),
    }),
    close: async () => { await runtime.close(); sts.close(); kubeApi.close(); await github.close(); db.cleanup(); },
  };
}

/** A person keeps the minting credentials and saves and approves the template `dig`, which covers the two needs. */
async function setUp(w: NeedWorld, h: CrashHost): Promise<void> {
  const vault = async (body: Record<string, unknown>) => { const r = await h.ui('/ui/api/vault', body); expect(r.status, JSON.stringify(r.body)).toBe(200); };
  await vault({ action: 'set', name: 'AWS_LAB', mints: { kind: 'aws-account', name: ACCOUNT }, value: JSON.stringify({ AccessKeyId: 'AKIAMINTING', SecretAccessKey: MINTING_SECRET, Region: 'eu-west-1', Endpoint: w.sts.url }) });
  await vault({ action: 'set', name: 'KUBE_LAB', mints: { kind: 'cluster', name: 'lab' }, value: JSON.stringify({ server: w.kubeApi.url, token: KUBE_MINTING_TOKEN }) });
  await vault({ action: 'save-template', name: TEMPLATE, image: 'localhost/box-dig:1', secrets: [], profiles: PROFILES });
  await vault({ action: 'approve-template', name: TEMPLATE });
}

/** A job's request on `/job/step` as `hopper-step` sends it; a host killed meanwhile answers status 0. */
async function asJob(h: CrashHost, proxyToken: string, method: string, path: string): Promise<{ status: number; headers: Record<string, unknown>; text: string }> {
  try {
    return await rawRequest(h.url, {
      method, path, ...(method === 'POST' ? { body: '' } : {}),
      headers: { authorization: `Bearer ${proxyToken}`, ...(method === 'POST' ? { 'content-type': 'application/x-tar' } : {}) },
    });
  } catch { return { status: 0, headers: {}, text: '' }; }
}

const ask = (h: CrashHost, proxyToken: string, command: string) =>
  asJob(h, proxyToken, 'POST', `${STEP_PATH}?${new URLSearchParams({ needs: NEEDS, key: KEY, command, timeout: '600' }).toString()}`);

/** The one step kept. */
function keptStep(url: string): string {
  const db = openDb(url);
  try {
    const rows = db.all('SELECT id FROM need_steps') as { id: string }[];
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  } finally { db.close(); }
}

/** The `need-step` sagas, by key and state. */
export function needSagas(url: string): { key: string; state: string }[] {
  const db = openDb(url);
  try { return db.all('SELECT key, state FROM sagas WHERE kind = ?', NEED_STEP_SAGA) as { key: string; state: string }[]; } finally { db.close(); }
}

/** The need boxes made at the runtime, by each create: the external effect, counted where it outlives a host. */
const boxesMade = (w: NeedWorld): string[] => w.runtime.seen
  .filter((s) => s.method === 'POST' && s.path.endsWith('/containers/create') && (s.body as { labels?: Record<string, string> }).labels?.[NEED_LABEL] !== undefined)
  .map((s) => (s.body as { name: string }).name);

const running = (w: NeedWorld): boolean => [...w.libpod.containers.values()].some((c) => c.labels[NEED_LABEL] !== undefined && c.state === 'running');

/** No key — a minting credential's, the minted session's, or a minted token — in what a host wrote. */
function noKeyIn(h: CrashHost): void {
  for (const secret of [MINTING_SECRET, KUBE_MINTING_TOKEN, MINTED_AWS.SecretAccessKey, MINTED_AWS.SessionToken, MINTED_KUBE_TOKEN]) expect(h.output()).not.toContain(secret);
}

/**
 * Two hoppers live at once (issue #1662): the first runs a need box that runs on; a second starts on the same database.
 * What the second hopper deleted at the Kubernetes API by then, and then once the job stopped the step: the Secrets the
 * box's token is bound to are deleted only after its step ended.
 */
export async function secondHostWhileBoxRuns(w: NeedWorld): Promise<{ deletedWhileRunning: number; boundAtEnd: number }> {
  const a = await w.host({ job: true });
  const job = a.job!;
  await setUp(w, a);
  const asked = await ask(a, job.proxyToken, 'sleep 600 # hang');
  expect(asked.status, asked.text).toBe(202);
  const id = String(asked.headers[STEP_HEADER.id]);
  await waitFor(() => (running(w) ? true : undefined), { timeoutMs: 30_000, what: 'the need box to run' });
  const secrets = (method: string) => w.kubeApi.seen.filter((s) => s.method === method && s.url.includes('/secrets')).length;
  expect(secrets('POST')).toBeGreaterThan(0);
  const b = await w.host();
  // The second hopper's passes at its start: its sandbox sweep and its reconcile pass of the sandboxes' tokens.
  await new Promise((r) => setTimeout(r, 3_000));
  const deletedWhileRunning = secrets('DELETE');
  expect(running(w)).toBe(true);
  await asJob(a, job.proxyToken, 'DELETE', `${STEP_PATH}/${id}`);
  await waitFor(() => (needSagas(w.url)[0]?.state === 'compensated' ? true : undefined), { timeoutMs: 30_000, what: 'the stopped step\'s saga to end' });
  await waitFor(() => (secrets('POST') === secrets('DELETE') ? true : undefined), { timeoutMs: 30_000, what: 'every minted token\'s Secret deleted' });
  noKeyIn(a);
  noKeyIn(b);
  return { deletedWhileRunning, boundAtEnd: secrets('POST') - secrets('DELETE') };
}

export interface Ended { exit: number; problem: string | undefined; saga: string }

/**
 * The scenario: a first hopper, whose job asks for a need step, killed at `point` — or, with no point, killed while the
 * need box runs; with `stop`, the job stops its running step and the hopper is killed while it compensates. A second
 * hopper ends the saga. Then the need box was made once at the most, no box or home is left at the runtime, every
 * Secret a minted token was bound to is deleted, and the job reads one result from the second hopper: what it answers.
 */
export async function killedThenEnded(w: NeedWorld, o: { point?: string; stop?: boolean }): Promise<Ended> {
  const a = await w.host({ job: true, ...(o.point ? { killPoint: o.point } : {}) });
  const job = a.job!;
  await setUp(w, a);
  const hang = o.stop === true || o.point === undefined;
  const asked = await ask(a, job.proxyToken, hang ? 'sleep 600 # hang' : 'aws sts get-caller-identity');
  if (hang) {
    expect(asked.status, asked.text).toBe(202);
    const id = String(asked.headers[STEP_HEADER.id]);
    await waitFor(() => (running(w) ? true : undefined), { timeoutMs: 30_000, what: 'the need box to run' });
    if (o.stop) void asJob(a, job.proxyToken, 'DELETE', `${STEP_PATH}/${id}`);
    else await a.kill();
  }
  if (o.point) await killedAt(a, o.point);
  endLeases(w.url);
  const b = await w.host();
  const ended = await waitFor(() => {
    const sagas = needSagas(w.url);
    return sagas.length === 1 && (sagas[0]!.state === 'done' || sagas[0]!.state === 'compensated') ? sagas[0]! : undefined;
  }, { timeoutMs: 60_000, what: 'the second hopper to end the step\'s saga' });
  const step = keptStep(w.url);
  expect(ended.key).toBe(step);
  expect(boxesMade(w).length).toBeLessThanOrEqual(1);
  // The box a killed host left is burned by the next host's sandbox sweep, at its start.
  await waitFor(() => (w.libpod.containers.size === 0 && w.libpod.volumes.size === 0 ? true : undefined), { timeoutMs: 30_000, what: 'no need box or home left at the runtime' });
  const secrets = (method: string) => w.kubeApi.seen.filter((s) => s.method === method && s.url.includes('/secrets')).length;
  expect(secrets('POST')).toBeGreaterThan(0);
  await waitFor(() => (secrets('POST') === secrets('DELETE') ? true : undefined), { timeoutMs: 30_000, what: 'every minted token\'s Secret deleted' });
  // The job's ask sent again is the same step; the job reads its one result.
  expect(String((await ask(b, job.proxyToken, 'aws sts get-caller-identity')).headers[STEP_HEADER.id])).toBe(step);
  const result = await asJob(b, job.proxyToken, 'GET', `${STEP_PATH}/${step}`);
  expect(result.status, result.text).toBe(200);
  noKeyIn(a);
  noKeyIn(b);
  const problem = result.headers[STEP_HEADER.problem];
  return { exit: Number(result.headers[STEP_HEADER.exit]), problem: typeof problem === 'string' ? problem : undefined, saga: ended.state };
}
