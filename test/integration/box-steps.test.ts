// Issue #1004 (the ask of #990): a job on a seat asks for a sandbox, the hopper starts the box, and the job runs its step
// in that box — no routing rule, no move of the job. The daemon, store, HTTP edge and the box's client are real; OpenFGA
// and the container runtime are doubles at their ports (the runtime runs a box's command on this machine). The job runs
// the real `hopper-skill` and `hopper-step` scripts with its own proxy token.
//
// Feature: box steps
//   Scenario: a seat job runs a step in the box the hopper started for it
//     Given sandbox YOLO, and a job on the hopper's own machine that asked for a sandbox and got box B
//     Then the sandbox answer tells the job to run its commands in B as box steps
//     And `hosts` lists B as a box this job's steps may run in
//     When the job runs `box B --input plan --command … --output result.txt --into out`
//     Then the step's output streams back, the script exits with the step's exit code, and result.txt is in out
//     And step.started and step.finished name the box on the job's timeline
//   Scenario: a box that is not this job's, or a --secret, is refused: exit 125, step.refused
//   Scenario: while the step runs, the box's vault helper asks for the job, and the vault takes the ask as the job's on
//     the box; outside a step, the same ask from the box is refused: the job does not run there
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { joinHopper } from '../../src/client/join.ts';
import { startLinkedClient } from '../../src/client/main.ts';
import type { Client } from '../../src/client/server.ts';
import { noGrant } from '../../src/domain/vault-grants.ts';
import type { VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { STEP_NOT_RUN, STEP_SCRIPT } from '../../src/windows-steps/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { createFakeContainerRuntime, type FakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { testInstallDir } from '../support/client.ts';
import { helper } from '../support/vault-box.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const HERDR = fileURLToPath(new URL('../herdr/fake-herdr-bin.mjs', import.meta.url));
chmodSync(HERDR, 0o755);

const NEEDS = 'write/aws-account/123456789012';
const ASK = ['--why', 'Create the role for the report', '--plan', 'aws iam create-role --role-name report (undo: aws iam delete-role)'];

const apps: TestApp[] = [];
const clients: Client[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.stop();
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

type Run = { code: number; stdout: string; stderr: string };

/** A job on the hopper's own machine that asked for a sandbox under YOLO and got its box: the box's name. */
async function seatJobWithBox(): Promise<{ a: TestApp; session: string; runtime: FakeContainerRuntime; job: string; creds: string; box: string; answer: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const runtime = createFakeContainerRuntime();
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(3) }, seams: { authorizationServer: createFakeAuthorizationServer(), containerRuntime: runtime } });
  apps.push(a);
  const session = await a.login();
  expect((await a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: session })).status).toBe(200);
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  const creds = temp('job-credentials-');
  writeFileSync(join(creds, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id)}\n`, { mode: 0o600 });
  writeFileSync(join(creds, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
  const asked = await run(a, creds, 'skill', ['sandbox', '--needs', NEEDS, ...ASK, '--wait', '--timeout', '60']);
  expect(asked.code, asked.stdout + asked.stderr).toBe(0);
  const v = (await a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': session })).body;
  const box = v.sandboxRequests![0]!.container!;
  return { a, session, runtime, job: job.id, creds, box, answer: asked.stdout };
}

function run(a: TestApp, creds: string, script: 'skill' | 'step', args: string[], cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, script), ...args], { cwd, env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('box steps (issue #1004)', () => {
  it('a seat job runs a step in the box the hopper started for it, and gets its log, exit code and outputs', async () => {
    const { a, runtime, job, creds, box, answer } = await seatJobWithBox();
    expect(answer).toContain(`This job runs on machine local, not on box ${box}.`);
    expect(answer).toContain(`sh "$HOPPER_STEP" box ${box} --command`);

    const hosts = await run(a, creds, 'step', ['hosts']);
    expect(hosts.code, hosts.stderr).toBe(0);
    expect(hosts.stdout).toMatch(new RegExp(`^box ${box}  template asked-[0-9a-f]+$`, 'm'));

    const work = temp('seat-work-');
    mkdirSync(join(work, 'plan'));
    writeFileSync(join(work, 'plan', 'role.json'), '{"role":"report"}\n');
    const r = await run(a, creds, 'step', ['box', box, '--input', 'plan', '--command', 'echo "in $(pwd)"; cat plan/role.json > result.txt; echo applied; exit 4', '--output', 'result.txt', '--into', 'out'], work);
    expect(r.code, r.stderr).toBe(4);
    const home = runtime.homes.get(box)!;
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    expect(r.stdout).toBe(`in ${join(home, 'work')}\napplied\n`);
    expect(readFileSync(join(work, 'out', 'result.txt'), 'utf8')).toBe('{"role":"report"}\n');
    expect(r.stderr).toContain('hopper-step: exit 4');

    const events = (await a.events()).filter((e) => e.type.startsWith('step.'));
    expect(events.map((e) => e.type)).toEqual(['step.started', 'step.finished']);
    expect(events[0]).toMatchObject({ jobId: job, data: { box, inputsBytes: expect.any(Number), outputs: ['result.txt'] } });
    expect(events[0]!.data).not.toHaveProperty('host');
    expect(events[1]).toMatchObject({ jobId: job, data: { box, exit: 4 } });
  });

  it('a box that is not this job\'s, or a --secret, is refused: exit 125, step.refused', async () => {
    const { a, creds, box } = await seatJobWithBox();
    const other = await run(a, creds, 'step', ['box', 'hopper-sandbox-someone-else', '--command', 'true']);
    expect(other.code).toBe(STEP_NOT_RUN);
    expect(other.stdout).toContain(`no: this job has no box hopper-sandbox-someone-else. Its boxes: ${box}.`);
    const secret = await run(a, creds, 'step', ['box', box, '--secret', 'AWS_KEY', '--command', 'true']);
    expect(secret.code).toBe(STEP_NOT_RUN);
    expect(secret.stdout).toContain('a box step takes no --secret');
    const refused = (await a.events()).filter((e) => e.type === 'step.refused');
    expect(refused.map((e) => e.data)).toEqual([
      { reason: expect.stringContaining('this job has no box hopper-sandbox-someone-else'), box: 'hopper-sandbox-someone-else' },
      { reason: expect.stringContaining('a box step takes no --secret'), box },
    ]);
  });

  it('while the step runs, the box\'s vault helper asks for the job, and the vault takes it as the job\'s on the box; outside a step, it does not', async () => {
    const { a, runtime, job, creds, box } = await seatJobWithBox();
    // The box's client joins with the line the hopper gave the box, as its entrypoint would.
    const { HOPPER_JOIN: line, HOPPER_CLIENT_NAME: name } = runtime.boxes.get(box)!.spec.env;
    const client = temp('hopper-box-');
    await joinHopper({ line: line!, name: name!, dir: client });
    clients.push(startLinkedClient({ dir: client, herdrBin: HERDR, session: 'hopper', installDir: testInstallDir(), backoffMs: [50] }));
    await waitFor(async () => ((await a.api('GET', '/api/machines')).body.machines as { id: string; online: boolean; client?: { vault?: string } }[]).find((m) => m.id === box && m.online && m.client?.vault), { timeoutMs: 10000, what: `${box} online with its vault helper` });
    cleanups.push(() => { const h = runtime.homes.get(box); if (h) rmSync(h, { recursive: true, force: true }); });

    // In a step, the helper's ask is the job's on the box: it passes the machine checks and stops at the job's vault grant.
    const r = await run(a, creds, 'step', ['box', box, '--command', '"$HOPPER_SECRET" get KUBE_TOKEN; echo "helper exit $?"']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(noGrant(job));
    expect(r.stdout).toContain('helper exit 1');
    expect((await a.events()).find((e) => e.type === 'vault.grant_asked')).toMatchObject({ jobId: job, machineId: box, data: { machine: box, name: 'KUBE_TOKEN' } });

    // Outside a step, the same ask from the box is refused: the job does not run there.
    const outside = await helper(client, ['get', 'KUBE_TOKEN'], join(creds, 'token'));
    expect(outside.code).not.toBe(0);
    expect(outside.stderr).toContain(`the job does not run on ${box}`);
  });
});
