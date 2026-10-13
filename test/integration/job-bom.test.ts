// Issue #935: GET /api/jobs/:id/bom answers a job's parts list — its issue, runs, pull request, questions, artifacts and
// the rest, grouped, each with its status and page —, a plain-words header and summary, and its events newest first.
// Real database and HTTP server.
import { afterEach, describe, expect, it } from 'vitest';
import type { JobBom } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function start(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(2) }, seams: { levels: [] } });
  return t;
}

const PR = 'https://github.com/acme/app/pull/12';
const ISSUE = 'https://github.com/acme/app/issues/7';

describe('GET /api/jobs/:id/bom (issue #935)', () => {
  it('answers the parts of a job that asked a question and opened a pull request', async () => {
    const a = await start();
    const asks = await a.pull({ op: 'ask', message: 'Which store should the cache use?' }, { key: 'item-7' });
    const q = await a.waitForQuestion(asks.id, (x) => x.status === 'open');
    const { store } = a.user();
    store.jobs.update(asks.id, {
      source: { source: 'manual', kind: 'item', key: ISSUE, url: ISSUE, repo: 'acme/app', number: 7, title: 'Make the cache faster' },
      sourceState: { source: { pullRequest: PR, follow: 'open', seen: { checks: 'pending', headRef: 'issue-7' } } },
    });

    const r = await a.api<JobBom>('GET', `/api/jobs/${asks.id}/bom`);
    expect(r.status).toBe(200);
    const bom = r.body;
    expect(bom.jobId).toBe(asks.id);
    expect(bom.header).toMatchObject({ asked: 'Make the cache faster (acme/app#7)', stands: 'Waiting on you: answer a question', next: 'You: answer the question.' });
    expect(bom.parts[0]).toMatchObject({ id: `question:${q.id}`, group: 'decisions', status: 'waiting_on_you', href: '#questions' });
    expect(bom.parts.find((p) => p.id === 'issue:acme/app#7')).toMatchObject({ group: 'asked', url: ISSUE });
    expect(bom.parts.find((p) => p.id === `pr:${PR}`)).toMatchObject({ group: 'code', status: 'open' });
    expect(bom.parts.filter((p) => p.kind === 'run').length).toBeGreaterThanOrEqual(1);
    expect(bom.summary).toMatch(/1 waiting on you\.$/);
    const seqs = bom.events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => y - x));
    expect(bom.events.map((e) => e.type)).toEqual(expect.arrayContaining(['job.queued', 'job.started', 'question.asked']));
    expect(bom.events.every((e) => e.jobId === asks.id)).toBe(true);
  });

  it('answers 404 for a job it does not know', async () => {
    const a = await start();
    expect((await a.api('GET', '/api/jobs/nope/bom')).status).toBe(404);
  });
});
