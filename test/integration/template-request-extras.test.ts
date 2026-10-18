// Issue #1875, part 2, through the real composition root and the real HTTP server: a running job asks, with the real
// `hopper-skill`, for a template with vault secrets, the hopper's test image and an egress host, and no need. The
// hopper saves it as asked; no policy or toggle approves it, so it waits for a person. Once a person approves it, the
// same ask answers it ready.
//
// Feature: a job asks for the template an end-to-end test needs
//   Scenario: a template with secrets, the test image and an egress host waits for a person, whatever the toggles say
//     Given the vault secrets E2E_PASSWORD and E2E_USERS, and skip template approval on
//     And a job running on the hopper's machine
//     When the job runs `sh "$HOPPER_SKILL" sandbox-template --why … --secrets "E2E_PASSWORD E2E_USERS"
//       --egress auth.example.test:443 --image test`
//     Then it is told the template waits for a person, and why
//     And the vault holds it: the test image, the two secrets, the host, no profile, none of it approved
//     When an admin approves it
//     Then the same ask answers it ready, and names the sandbox ask by the template
//   Scenario: an image reference of the job's own is refused
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TemplateView, VaultView } from '../../src/domain/types.ts';
import { proxyToken } from '../../src/github-proxy/token.ts';
import { TEST_IMAGE } from '../../src/sandbox/box-image.ts';
import { SKILL_SCRIPT } from '../../src/skills/index.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { KEY } from '../support/webhooks.ts';

const HOST = 'auth.example.test:443';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

async function boot(): Promise<{ a: TestApp; token: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const a = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, plugins: { machines: lanes(2) } });
  apps.push(a);
  const token = await a.login();
  for (const name of ['E2E_PASSWORD', 'E2E_USERS']) {
    expect((await a.ui('/ui/api/vault', { action: 'set', name, value: `${name}-value-0123456789` }, { token })).status).toBe(200);
  }
  expect((await a.ui('/ui/api/sandbox-approvals', { skipTemplateApproval: true, skipSandboxApproval: false }, { token })).status).toBe(200);
  return { a, token };
}

/** A job running on the hopper's own machine, and its credentials dir as the hopper keeps it: its proxy token and `hopper-skill`. */
async function runningJob(a: TestApp): Promise<string> {
  const job = await a.pull({ op: 'sleep', ms: 60000 });
  await a.waitForStatus(job.id, 'running', 10000);
  const dir = mkdtempSync(join(tmpdir(), 'job-credentials-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'token'), `${proxyToken(a.user().store.settings.getLinkKey()!.privateKey, a.user().user.id, job.id)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'skill'), SKILL_SCRIPT, { mode: 0o700 });
  return dir;
}

type Run = { code: number; stdout: string };
function skill(a: TestApp, creds: string, args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    execFile('sh', [join(creds, 'skill'), ...args], { env: { PATH: process.env.PATH, HOPPER_URL: a.url, HOPPER_TOKEN_FILE: join(creds, 'token') }, encoding: 'utf8' },
      (err, stdout) => resolve({ code: err ? Number((err as { code?: number }).code ?? 1) : 0, stdout }));
  });
}

const vault = async (a: TestApp): Promise<VaultView> => (await a.api('GET', '/api/vault')).body as VaultView;
const ASK = ['sandbox-template', '--why', 'Run the sign-in end-to-end test against the dev host', '--secrets', 'E2E_PASSWORD E2E_USERS', '--egress', HOST, '--image', 'test'];

describe('a template request with secrets, the test image and an egress host (issue #1875)', () => {
  it('waits for a person whatever the toggles say, and is ready once a person approves it', async () => {
    const { a, token } = await boot();
    const creds = await runningJob(a);

    const asked = await skill(a, creds, ASK);
    expect(asked.code).toBe(3);
    expect(asked.stdout).toContain('waits for a person');
    expect(asked.stdout).toContain('a vault secret or an egress host is approved by a person only');
    const t = (await vault(a)).templates.find((x) => x.name.startsWith('asked-')) as TemplateView;
    expect(t).toMatchObject({ image: TEST_IMAGE, secrets: ['E2E_PASSWORD', 'E2E_USERS'], egress: [HOST], profiles: [], gives: [] });
    expect(t.approval).toBeUndefined();

    expect((await a.ui('/ui/api/vault', { action: 'approve-template', name: t.name }, { token })).status).toBe(200);
    const ready = await skill(a, creds, ASK);
    expect(ready.code).toBe(0);
    expect(ready.stdout).toContain(`template ${t.name} is ready, approved by a person`);
    expect(ready.stdout).toContain(`sandbox --template ${t.name} --wait`);
    expect((await vault(a)).templates.find((x) => x.name === t.name)).toMatchObject({ gives: ['E2E_PASSWORD', 'E2E_USERS'] });
  });

  it('refuses an image reference of the job\'s own', async () => {
    const { a } = await boot();
    const creds = await runningJob(a);
    const r = await skill(a, creds, ['sandbox-template', '--why', 'A test', '--secrets', 'E2E_PASSWORD', '--image', 'docker.io/library/python:3']);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('one of the hopper\'s box images: box, test');
  });
});
