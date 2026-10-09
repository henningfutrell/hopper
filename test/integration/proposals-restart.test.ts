// Proposals across a daemon restart (issue #537): two app instances over one database, sharing one manual source. A
// job waiting on its proposal stays waiting, its proposal open and decidable; one at a reviewer level is reviewed again.
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewItemView } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createManualSource } from '../support/manual-source.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
let cleanup: (() => void) | undefined;

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  cleanup?.();
});

const source = createManualSource();
const boot = async (dbPath: string) => { const a = await startTestApp({ dbPath, source }); apps.push(a); return a; };
const open = async (a: TestApp) => (await a.api<{ items: ReviewItemView[] }>('GET', '/api/proposals')).body.items;

describe('restart with a proposal', () => {
  it('keeps the job waiting on its proposal; accepting it after the restart ends the job', async () => {
    const db = tempDbPath();
    cleanup = db.cleanup;
    const first = await boot(db.dbPath);
    const job = await first.pull({ op: 'propose', message: 'Goal: paint the shed' });
    const p = await waitFor(async () => (await open(first)).find((x) => x.jobId === job.id && x.stage === 'human'));
    await first.stop();

    const second = await boot(db.dbPath);
    expect((await second.job(job.id)).status).toBe('waiting_answer');
    expect((await open(second)).map((x) => [x.id, x.status])).toEqual([[p.id, 'open']]);
    const token = await second.login();
    expect((await second.ui(`/ui/api/proposals/${p.id}/accept`, {}, { token })).status).toBe(200);
    expect((await second.waitForStatus(job.id, 'finished')).result).toEqual({ proposal: { id: p.id, version: 1, decision: 'accept' } });
  });
});
