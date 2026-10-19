// The secret canary check (issue #1957), part 4: a vault secret the vault delivered to a job, in that job's checkpoint.
// The checkpoint scrub masks secrets by their patterns (issue #921); a vault secret is a value a person set, with no
// pattern, so the scrub also masks, by value, each vault secret the vault delivered for the job. Through the real daemon
// over the fake herdr (as secret-canary-resume.test.ts), with the vault in the hopper and in a container of its own: a
// person sets a vault secret (a canary) and grants the job the vault; the vault delivers the secret for the job's step;
// the job's agent session and its work not pushed then hold it; the job is parked and checkpointed. The whole database,
// the work dir and the checkpoint opened hold no form of the canary.
//
// Feature: a vault secret delivered to a job is not kept in its checkpoint
//   Scenario Outline: the checkpoint of a job a vault secret was delivered to holds no form of it (<where the vault runs>)
import { homedir } from 'node:os';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointCapture, Job } from '../../src/domain/types.ts';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { databaseUrlFor } from '../support/database.ts';
import { canary, databasePlaces, filePlaces, report, scan, type Place } from '../support/secret-canary.ts';
import { startVaultContainer, VAULT_KEY } from '../support/vault-container.ts';
import { waitFor } from '../support/wait.ts';
import { KEY } from '../support/webhooks.ts';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000, promptSteadyMs: 100 } }];
const WORKING = { steps: ['● Sanding'], output: [], end: 'working' as const };

describe('the secret canary check, a vault secret in a checkpoint (issue #1957)', () => {
  it.each([['in the hopper', false], ['in a container of its own', true]] as const)('the checkpoint of a job a vault secret was delivered to holds no form of it (the vault %s)', async (_where, container) => {
    const secret = canary('vault');
    const capture: CheckpointCapture = { none: 'not yet' };
    const herdr = createFakeHerdrClient({ session: 'jh-test', turns: [WORKING, WORKING], repositories: [`${homedir()}/shed`], checkpoint: capture });
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const vault = container ? await startVaultContainer(db.dbPath, { HOPPER_MASTER_KEY: KEY }) : undefined;
    if (vault) cleanups.push(() => vault.stop());
    const a: TestApp = await startTestApp({
      dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY, ...(vault ? { HOPPER_VAULT_KEY: VAULT_KEY } : {}) },
      plugins: { executors: EXECUTORS, machines: [{ name: 'local', plugin: 'local', options: { lanes: 1, workTree: '~/shed' } }] },
      seams: { herdr, levels: [] }, ...(vault ? { env: { HOPPER_VAULT_URL: vault.url } } : {}),
    });
    cleanups.push(() => a.stop());
    const token = await a.login();
    const { store } = a.user();
    expect((await a.ui('/ui/api/vault', { action: 'set', name: 'DEPLOY_PASSWORD', value: secret }, { token })).status).toBe(200);

    // The job runs; a person grants it the vault, and the vault delivers the secret for its step.
    const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} });
    await a.waitForStatus(job.id, 'running');
    await waitFor(() => herdr.prompts.length > 0, { what: 'the prompt sent' });
    expect((await a.ui(`/ui/api/jobs/${job.id}/grant-vault`, {}, { token })).status).toBe(200);
    expect(await a.user().vault.forStep({ name: 'DEPLOY_PASSWORD', job: job.id, host: 'win-1' })).toEqual({ value: secret });

    // The agent said the secret, and wrote it into the work not pushed.
    const taken = capture as { none?: string; taken?: unknown };
    delete taken.none;
    taken.taken = {
      branch: 'hopper/shed', base: 'b'.repeat(40), head: 'c'.repeat(40), commits: ['ccccccc Sand the shed'],
      patch: gzipSync(`diff --git a/deploy.env b/deploy.env\n+++ b/deploy.env\n+colour=blue\n+DEPLOY_PASSWORD=${secret}\n`),
      session: gzipSync(`${JSON.stringify({ type: 'user', message: `the step printed ${secret}` })}\nplain ${secret}\n`),
    };
    expect((await a.ui<Job>(`/ui/api/jobs/${job.id}/park`, {}, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'parked');
    await waitFor(async () => (await a.job(job.id)).checkpoint !== undefined, { what: 'the checkpoint at the park' });

    const kept = store.checkpoints.get(job.id)!;
    const opened = { patch: gunzipSync(kept.patch).toString('latin1'), session: gunzipSync(kept.session!).toString('utf8') };
    const places: Place[] = [
      ...databasePlaces(databaseUrlFor(a.dbPath)),
      ...filePlaces('work dir', a.dataDir),
      { name: 'checkpoint as kept', text: JSON.stringify(opened) },
    ];
    expect(report(scan({ 'vault secret': secret }, places))).toBe('');
    // The controls: the checkpoint is kept, with the rest of the work and the masked value in its place.
    expect(opened.patch).toContain('+colour=blue');
    expect(opened.patch).toContain('+DEPLOY_PASSWORD=[vault secret, masked]');
    expect(opened.session).toContain('the step printed [vault secret, masked]');
  }, 60_000);
});
