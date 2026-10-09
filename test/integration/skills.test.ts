// Issue #582: a box asks the hopper what it can set up, and loads one skill on request. The daemon, store, HTTP edge
// and a joined client are real; OpenFGA is a double at the AuthorizationServer seam. The job runs the real
// `hopper-skill` script (sh and curl) against the hopper, with its own proxy token (issue #563): the request is the
// job's, on its box, so Access (issue #559) checks the box's template before anything is set up.
//
// Feature: the skill catalog and broker
//   Scenario: a job asks what the hopper can set up
//     Given a job running on a machine
//     When the job runs `sh "$HOPPER_SKILL"`
//     Then it gets the catalog: one short line per skill, and how to load one
//     And the request is on the job's timeline (`skill.listed`)
//   Scenario: a job loads a skill that needs no access
//     Then it gets the skill's full text, and `skill.loaded` is on its timeline
//   Scenario: a job asks for a skill the hopper does not have
//     Then it gets a clear no with the reason and the skills there are, and `skill.refused` is on its timeline
//   Scenario: a box asks for a link Access does not allow
//     Given a box of the template kube, and no approval for kube to read on cluster prod
//     When the job on the box runs `sh "$HOPPER_SKILL" kube-diagnostics cluster/prod`
//     Then it gets a clear no with Access's reason, and the decision is recorded in Access
//   Scenario: once Access allows it, the box gets the skill and its link, for that box only
//     Then the answer names the vault secrets of the box's template, through the vault's helper, never a value
//   Scenario: a machine of no template, a skill with no asset, a token that is no job's: each a clear no
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import type { AccessView, DomainEvent } from '../../src/domain/types.ts';
import { PROXY_HELP } from '../../src/github-proxy/index.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);
const VALUE = 'k3s-token-0123456789abcdef-never-sent-by-a-skill';

let t: TestApp | undefined;
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
const saved = { ...process.env };

afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
  process.env = { ...saved };
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

async function boot(): Promise<{ a: TestApp; session: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  process.env.FAKE_HERDR_DIR = join(db.dbPath, '..');
  process.env.FAKE_HERDR_RUNNING = '1';
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_TOKEN_KEY: KEY },
    plugins: { executors: [{ name: 'test', plugin: 'test' }], machines: [], machineDefaults: { lanes: 1, executors: ['scripted'] } },
    seams: { authorizationServer: createFakeAuthorizationServer() },
  });
  const session = await t.login();
  const vault = (body: Record<string, unknown>) => t!.ui('/ui/api/vault', body, { token: session });
  await vault({ action: 'set', name: 'KUBE_TOKEN', scope: 'cluster prod, read only', value: VALUE });
  await vault({ action: 'save-template', name: 'kube', image: 'localhost/box-kubectl:1', secrets: ['KUBE_TOKEN'] });
  await vault({ action: 'approve-template', name: 'kube' });
  return { a: t, session };
}

/** A machine joined — as a box of `template`, when given — and its client started. */
async function joinMachine(a: TestApp, session: string, name: string, template?: string): Promise<void> {
  const dir = temp('hopper-machine-');
  const code = (await a.ui<{ code: string }>('/ui/api/machines/join', template ? { template } : {}, { token: session })).body.code;
  await joinHopper({ line: `${a.url}#${code}`, name, dir });
  clients.push(startLinkedClient({ dir, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
  await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean }[]).find((m) => m.id === name && m.online), { timeoutMs: 10000, what: `${name} online` });
}

/** A job that runs a while, on the one machine there is. */
async function runningJob(a: TestApp, machine: string): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  expect((await a.waitForStatus(job.id, 'running', 10000)).laneId).toBe(`${machine}/lane-1`);
  return job.id;
}

interface Run { code: number; stdout: string; stderr: string }

/** `hopper-skill`, run as a job on its box runs it: the script and its proxy token in the job's credentials dir. */
function skill(a: TestApp, job: string, args: string[], token?: string): Promise<Run> {
  const dir = temp('job-credentials-');
  writeFileSync(join(dir, 'token'), `${token ?? proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return new Promise((resolve) => {
    execFile('sh', [join(dir, 'skill'), ...args], {
      env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(dir, 'token') } as NodeJS.ProcessEnv, encoding: 'utf8',
    }, (err, stdout, stderr) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

const eventsOf = (a: TestApp, type: string): DomainEvent[] => a.user().store.events.recent(1000).filter((e) => e.type === type);
const access = async (a: TestApp, session: string) => (await a.api<AccessView>('GET', '/api/access', undefined, { 'x-hopper-session': session })).body;

describe('the skill catalog and broker (issue #582)', () => {
  it('answers the catalog in a few short lines, loads a skill that needs no access, and says no to a skill it does not have', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'desk');
    const job = await runningJob(a, 'desk');

    const catalog = await skill(a, job, []);
    expect(catalog.code).toBe(0);
    const lines = catalog.stdout.trim().split('\n');
    expect(lines).toEqual(expect.arrayContaining([
      expect.stringMatching(/^github: /), expect.stringMatching(/^kube-diagnostics: /), expect.stringMatching(/^aws-diagnostics: /),
    ]));
    expect(lines.at(-1)).toMatch(/sh "\$HOPPER_SKILL" NAME/);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(160);
    expect(catalog.stdout.length).toBeLessThan(800);
    expect(eventsOf(a, 'skill.listed')).toEqual([expect.objectContaining({ jobId: job, data: expect.objectContaining({ machine: 'desk' }) })]);

    const github = await skill(a, job, ['github']);
    expect(github).toMatchObject({ code: 0 });
    expect(github.stdout).toContain(PROXY_HELP);
    expect(eventsOf(a, 'skill.loaded')).toEqual([expect.objectContaining({ jobId: job, data: expect.objectContaining({ skill: 'github', machine: 'desk' }) })]);

    const render = await skill(a, job, ['render']);
    expect(render.code).toBe(1);
    expect(render.stdout).toMatch(/^no: the hopper has no skill render\. It has: github, kube-diagnostics, aws-diagnostics\. Find another way\./);
    expect(eventsOf(a, 'skill.refused')).toEqual([expect.objectContaining({ jobId: job, data: expect.objectContaining({ skill: 'render', reason: expect.stringContaining('no skill render') }) })]);
  });

  it('a box gets a clear no with Access\'s reason; once Access allows it, the skill and its link for that box, never a value', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'hopper-sandbox-kube', 'kube');
    const job = await runningJob(a, 'hopper-sandbox-kube');

    const denied = await skill(a, job, ['kube-diagnostics', 'cluster/prod']);
    expect(denied.code).toBe(1);
    expect(denied.stdout).toMatch(/^no: Access denied it: template kube is not approved to read on cluster prod\./);
    const refused = eventsOf(a, 'skill.refused')[0]!;
    expect(refused).toMatchObject({ jobId: job, data: { skill: 'kube-diagnostics', asset: 'cluster/prod', template: 'kube', machine: 'hopper-sandbox-kube', decision: expect.any(String) } });
    const [decision] = (await access(a, session)).decisions;
    expect(decision).toMatchObject({ id: (refused.data as { decision: string }).decision, allowed: false, template: 'kube', operation: 'read', asset: { kind: 'cluster', name: 'prod' }, job: { jobId: job } });

    await a.ui('/ui/api/access', { action: 'approve', template: 'kube', operation: 'read', asset: { kind: 'cluster', name: 'prod' } }, { token: session });
    const allowed = await skill(a, job, ['kube-diagnostics', 'cluster/prod']);
    expect(allowed).toMatchObject({ code: 0 });
    expect(allowed.stdout).toContain('kubectl');
    expect(allowed.stdout).toContain('Access allowed it: template kube is approved to read on cluster prod');
    expect(allowed.stdout).toMatch(/KUBE_TOKEN \(cluster prod, read only\)/);
    expect(allowed.stdout).toMatch(/args: \[kube, KUBE_TOKEN\]/);
    expect(allowed.stdout).not.toContain(VALUE);
    expect(eventsOf(a, 'skill.loaded')).toEqual([expect.objectContaining({ jobId: job, data: expect.objectContaining({ skill: 'kube-diagnostics', asset: 'cluster/prod', template: 'kube', decision: expect.any(String) }) })]);
    expect((await access(a, session)).decisions[0]).toMatchObject({ allowed: true, job: { jobId: job } });
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(VALUE);
  });

  it('says no, with the reason, to a machine of no template, a skill named with no asset or a wrong one, and a token that is no job\'s', async () => {
    const { a, session } = await boot();
    await joinMachine(a, session, 'desk');
    const job = await runningJob(a, 'desk');

    const noTemplate = await skill(a, job, ['kube-diagnostics', 'cluster/prod']);
    expect(noTemplate.code).toBe(1);
    expect(noTemplate.stdout).toMatch(/^no: desk is no box of a template/);

    const noAsset = await skill(a, job, ['kube-diagnostics']);
    expect(noAsset.code).toBe(1);
    expect(noAsset.stdout).toMatch(/^no: kube-diagnostics sets up a link to a cluster or namespace: name it, as sh "\$HOPPER_SKILL" kube-diagnostics cluster\/NAME/);

    const wrongKind = await skill(a, job, ['kube-diagnostics', 'aws-account/123456789012']);
    expect(wrongKind.code).toBe(1);
    expect(wrongKind.stdout).toMatch(/^no: kube-diagnostics sets up a link to a cluster or namespace, not an aws-account/);
    expect(eventsOf(a, 'skill.refused')).toHaveLength(3);

    const stranger = await skill(a, job, [], 'bm8tb25l.not-a-job.mac');
    expect(stranger.code).toBe(1);
    expect(stranger.stdout).toMatch(/^no: the token is not a job's of this hopper/);
  });
});
