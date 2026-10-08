// The raising machine (issue #485), over the real HTTP server and database: a question records the
// machine, its name (label) and the lane that raised it, as a snapshot taken when it is asked;
// `question.asked` and every later question event carry it as subject and in their data; webhook
// receivers get it as stored; the snapshot stays put when the machine is later removed.
import { afterEach, describe, expect, it } from 'vitest';
import type { DomainEvent } from '../../src/domain/types.ts';
import { lanes, startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { writeWebhooks } from '../support/files.ts';
import { startReceiver, type Receiver } from '../support/receiver.ts';
import { waitFor } from '../support/wait.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;
let receiver: Receiver | undefined;

async function start(o: Omit<Parameters<typeof startTestApp>[0], 'dbPath'> & { before?: (dbPath: string) => void } = {}): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  o.before?.(db.dbPath);
  t = await startTestApp({ dbPath: db.dbPath, plugins: { machines: lanes(1) }, ...o });
  return t;
}

afterEach(async () => {
  await t?.stop();
  t = undefined;
  await receiver?.close();
  receiver = undefined;
  cleanup?.();
});

const ask = (message: string) => ({ op: 'ask', message });

/** The label the hopper shows for machine `id` now. */
async function labelOf(a: TestApp, id: string): Promise<string> {
  const r = await a.api<{ machines: { id: string; label: string }[] }>('GET', '/api/machines');
  return r.body.machines.find((m) => m.id === id)!.label;
}

describe('a question records and shows the machine that raised it (issue #485)', () => {
  it('ask() stores the machine id, name and lane; question.asked and the later events carry them', async () => {
    const a = await start();
    const name = await labelOf(a, 'local');
    const job = await a.pull(ask('Which colour?'), { title: 'paint the shed' });
    await a.waitForStatus(job.id, 'finished');
    const [q] = await a.questionsOf(job.id);
    const raisedBy = { machineId: 'local', name, laneId: 'local/lane-1' };
    expect(q!.raisedBy).toEqual(raisedBy);
    const events = (await a.events()).filter((e) => e.questionId === q!.id && e.type.startsWith('question.'));
    const asked = events.find((e) => e.type === 'question.asked')!;
    expect(asked).toMatchObject({ machineId: 'local', laneId: 'local/lane-1' });
    expect(asked.data).toEqual({ questionId: q!.id, text: 'Which colour?', detectedBy: 'test', raisedBy });
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['question.asked', 'question.escalated', 'question.answered']));
    for (const e of events) expect(e, e.type).toMatchObject({ machineId: 'local', laneId: 'local/lane-1', data: { raisedBy } });
    // GET /api/questions/:id answers the same snapshot.
    const one = await a.api('GET', `/api/questions/${q!.id}`);
    expect(one.body.raisedBy).toEqual(raisedBy);
  });

  it('the snapshot stays put after the machine is removed', async () => {
    // No configured level names the machine, so it may be removed (the fake levels answer at their seam).
    const a = await start({ plugins: { machines: lanes(1), escalationLevels: [] } });
    const job = await a.pull(ask('Which colour?'));
    await a.waitForStatus(job.id, 'finished');
    const [before] = await a.questionsOf(job.id);
    const token = await a.login();
    const version = (await a.api<{ config: { version: string } }>('GET', '/api/plugins')).body.config.version;
    const removed = await a.ui('/ui/api/plugins', { action: 'remove', role: 'machine-source', name: 'local', version }, { token });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const [after] = await a.questionsOf(job.id);
    expect(after!.raisedBy).toEqual(before!.raisedBy);
    expect(after!.raisedBy?.machineId).toBe('local');
  });

  it('a webhook delivery of a question event includes the machine', async () => {
    receiver = await startReceiver();
    const url = receiver.url;
    const a = await start({ secrets: { WEBHOOK_SECRET_R: 's' }, before: (db) => writeWebhooks(db, [{ name: 'r', url, events: ['question.asked', 'question.answered'], secretEnv: 'WEBHOOK_SECRET_R' }]) });
    const job = await a.pull(ask('Which colour?'));
    await a.waitForStatus(job.id, 'finished');
    const bodies = await waitFor(() => {
      const got = receiver!.received.map((r) => JSON.parse(r.body) as DomainEvent);
      return got.length >= 2 ? got : undefined;
    }, { what: 'two deliveries' });
    for (const b of bodies) {
      expect(b, b.type).toMatchObject({ machineId: 'local', laneId: 'local/lane-1', data: { raisedBy: { machineId: 'local', laneId: 'local/lane-1' } } });
      expect(typeof (b.data.raisedBy as { name?: unknown }).name).toBe('string');
    }
  });
});
