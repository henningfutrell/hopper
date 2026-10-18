// Issue #1875, part 3, through the real composition root, the real HTTP server and the real `hopper-skill` and
// `hopper-step`: a job asks for a sandbox of a template with vault secrets, the test image and an egress host; a person
// approves the template; the job runs a box step of it. The step gets the template's vault secrets only after a person
// granted the job the vault, copied into its need box as files, and the job never reads a value. The container runtime
// is a double at its port whose one-shot containers run the real need box script under `sh`; OpenFGA is a double at its
// seam.
//
// Feature: a box step gets its template's vault secrets
//   Scenario: a box step of a template with secrets waits for the job's vault grant, then reads them in the box only
//     Given the vault secrets E2E_PASSWORD and E2E_USERS, and sandbox YOLO
//     And a job that asked for a sandbox with those secrets, the test image and an egress host, which a person approved
//     When the job runs a box step that reads E2E_PASSWORD with "$HOPPER_SECRET" get
//     Then the step does not run: it says the job has no vault grant, and a person is asked, for that box step
//     When a person grants the job the vault, and the job runs the step again
//     Then the command reads the secret in the box; the job's output shows it masked; the box's environment holds no value
//     And the vault records that it gave the secret to the need box, never its value
//     When a step asks back an output that holds the secret's value
//     Then the output is not brought back, and the step says why
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent, VaultView } from '../../src/domain/types.ts';
import { HOME } from '../../src/sandbox/flags.ts';
import { NEED_LABEL } from '../../src/sandbox/need-box.ts';
import { OUTPUTS_HOLD_SECRET } from '../../src/sandbox/need-steps.ts';
import { STEP_NOT_RUN, STEP_SCRIPT } from '../../src/windows-steps/script.ts';
import { boot, runningJob, skill, stopAll, type Booted, type Run } from '../support/read-only-check.ts';

afterEach(stopAll);

const PASSWORD = 'e2e-password-value-0123456789';
const HOST = 'auth.example.test:443';
const ASK = ['sandbox', '--why', 'Run the sign-in end-to-end test against the dev host', '--secrets', 'E2E_PASSWORD E2E_USERS', '--egress', HOST, '--image', 'test'];

function step(b: Booted, creds: string, args: string[], cwd?: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = spawn('sh', [join(creds, 'step'), ...args], { cwd, env: { PATH: process.env.PATH, HOPPER_URL: b.a.url, HOPPER_TOKEN_FILE: join(creds, 'token'), TMPDIR: b.cloud.dir } });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    p.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const ofJob = async (b: Booted, jobId: string, type: string): Promise<DomainEvent[]> => (await b.a.events()).filter((e) => e.jobId === jobId && e.type === type);

describe('a box step of a template with vault secrets (issue #1875)', () => {
  it('waits for the job\'s vault grant, then reads the secrets in its box only', async () => {
    const b = await boot([]);
    const homeOf = (name: string): string => { const h = join(b.cloud.dir, `home-${name}`); mkdirSync(h, { recursive: true }); return h; };
    const run = b.cloud.runScript;
    b.runtime.runScript = (spec) => run({ ...spec, env: { ...spec.env, HOME: homeOf(spec.name) } });
    b.runtime.copyIn = async (id, dir, tar) => {
      const c = [...b.runtime.boxes.values()].find((x) => x.id === id)!;
      const to = dir.replace(HOME, homeOf(c.spec.name));
      mkdirSync(to, { recursive: true });
      execFileSync('tar', ['-xf', tar, '-C', to]);
    };
    for (const [name, value] of [['E2E_PASSWORD', PASSWORD], ['E2E_USERS', '{"users":[]}']] as const) {
      expect((await b.a.ui('/ui/api/vault', { action: 'set', name, value }, { token: b.token })).status).toBe(200);
    }
    expect((await b.a.ui('/ui/api/sandbox-approvals', { yolo: true }, { token: b.token })).status).toBe(200);
    const creds = await runningJob(b.a);
    writeFileSync(join(creds, 'step'), STEP_SCRIPT, { mode: 0o700 });
    const jobId = b.a.user().store.jobs.list({ status: ['running'] }).at(-1)!.id;

    // The template waits for a person; once a person approves it, the sandbox runs are approved (YOLO).
    const first = await skill(b.a, creds, ASK);
    expect(first.code, first.stdout + first.stderr).not.toBe(0);
    const view = async () => (await b.a.api<VaultView>('GET', '/api/vault', undefined, { 'x-hopper-session': b.token })).body;
    const template = (await view()).templates.find((t) => t.name.startsWith('asked-'))!.name;
    expect((await b.a.ui('/ui/api/vault', { action: 'approve-template', name: template }, { token: b.token })).status).toBe(200);
    const asked = await skill(b.a, creds, ASK);
    expect(asked.code, asked.stdout + asked.stderr).toBe(0);

    const work = join(b.cloud.dir, 'seat-work');
    mkdirSync(work, { recursive: true });
    const command = 'echo "pw=$("$HOPPER_SECRET" get E2E_PASSWORD)"; env | grep -c e2e-password-value || true';
    const ungranted = await step(b, creds, ['box', template, '--command', command], work);
    expect(ungranted.code, ungranted.stdout + ungranted.stderr).toBe(STEP_NOT_RUN);
    expect(ungranted.stderr).toMatch(/E2E_PASSWORD: job [0-9a-f]{8} has no vault grant/);
    expect((await view()).grantAsks).toEqual([expect.objectContaining({ job: jobId, template, box: expect.stringMatching(new RegExp(`^hopper-need-${template}-`)), names: ['E2E_PASSWORD'] })]);
    expect((await ofJob(b, jobId, 'vault.grant_asked'))[0]!.data).toMatchObject({ job: jobId, template, name: 'E2E_PASSWORD' });

    expect((await b.a.ui(`/ui/api/jobs/${jobId}/grant-vault`, {}, { token: b.token })).status).toBe(200);
    const granted = await step(b, creds, ['box', template, '--command', command], work);
    expect(granted.code, granted.stdout + granted.stderr).toBe(0);
    expect(granted.stdout).toContain('pw=***');
    expect(granted.stdout).toMatch(/^0$/m);
    expect(granted.stdout + granted.stderr).not.toContain(PASSWORD);
    const boxes = [...b.runtime.ran.values()].filter((s) => s.labels[NEED_LABEL] !== undefined);
    expect(JSON.stringify(boxes.map((s) => s.env))).not.toContain(PASSWORD);
    const delivered = await ofJob(b, jobId, 'vault.step_delivered');
    expect(delivered.map((e) => e.data)).toEqual(expect.arrayContaining([{ name: 'E2E_PASSWORD', host: boxes.at(-1)!.name, job: jobId }]));
    expect(JSON.stringify(await b.a.events())).not.toContain(PASSWORD);

    // An output that holds the value does not come back to the job.
    const leak = await step(b, creds, ['box', template, '--command', '"$HOPPER_SECRET" get E2E_PASSWORD > copy.txt', '--output', 'copy.txt', '--into', 'out'], work);
    expect(leak.code).toBe(STEP_NOT_RUN);
    expect(leak.stderr).toContain(OUTPUTS_HOLD_SECRET);
    expect(existsSync(join(work, 'out', 'copy.txt'))).toBe(false);
  }, 60_000);
});
