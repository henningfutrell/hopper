// Claude at a dialog before the hopper sent it anything (issue #534), through the daemon: the job waits on a
// question to a person, its pane kept, the dialog and its options the question; the UI's answer goes into the
// dialog, then the job gets its task and finishes.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeHerdrClient } from '../../src/executors/herdr/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

const EXECUTORS = [{ name: 'test', plugin: 'test' }, { name: 'herdr-claude', plugin: 'herdr-claude', options: { pollMs: 10, idleNudgeMs: 5000 } }];
const NOTICE = ['─'.repeat(40), ' Claude Code has switched to a new default model', '', ' ❯ 1. Keep the new default', '   2. Choose another model', '', ' Enter to confirm · Esc to cancel'];
const DONE = { output: ['● Painted the shed.', '  HOPPER_DONE'] };

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

describe('a dialog before the prompt was sent, through the daemon', () => {
  it('waits on a question to a person with the dialog, keeps the pane, and runs on once it is answered', async () => {
    const herdr = createFakeHerdrClient({ session: 'jh-test', lateDialog: { lines: NOTICE, after: 1 }, turns: [DONE] });
    const db = tempDbPath();
    cleanup = db.cleanup;
    const a = t = await startTestApp({ dbPath: db.dbPath, plugins: { executors: EXECUTORS }, seams: { herdr, levels: [] } });
    const job = await a.pull({}, { executor: 'herdr-claude', prompt: 'Paint the shed', env: {} });
    const q = await a.waitForQuestion(job.id, (x) => x.tier === 'human');
    expect(q).toMatchObject({ detectedBy: 'blocked', status: 'open' });
    expect(q.text).toContain('1. Keep the new default\n2. Choose another model');
    expect((await a.job(job.id)).status).toBe('waiting_answer');
    expect(herdr.closed).toEqual([]);
    expect(herdr.prompts).toEqual([]);
    const types = (await a.events()).filter((e) => e.jobId === job.id).map((e) => e.type);
    expect(types).not.toContain('job.failed');

    const token = await a.login();
    expect((await a.ui(`/ui/api/questions/${q.id}/answer`, { answer: 'Keep the new default' }, { token })).status).toBe(200);
    await a.waitForStatus(job.id, 'finished', 8000);
    expect(herdr.texts.map((x) => x.text)).toContain('1');
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('Paint the shed')]);
  });
});
