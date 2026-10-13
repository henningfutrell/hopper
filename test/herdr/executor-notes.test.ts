// Issue #997: a person sends a note to a running job. The herdr-claude executor types it into the job's session at
// the next turn boundary only — Claude ready, its turn over —, never mid-turn and never over a dialog. A note that waits
// when the job starts goes in its task; one that waits when it resumes goes in with the answer. A turn that ends on a
// question or a report keeps the notes for the resume.
import { describe, expect, it } from 'vitest';
import type { ExecutionContext, NoteDelivery } from '../../src/domain/ports.ts';
import { STATUS_NOTE_NUDGE, type FakeTurn } from '../../src/executors/herdr/index.ts';
import { contextFor, jobWith, setup } from './support.ts';

const HOUR = 3600000;
const LONG: FakeTurn = { steps: ['● Reading the logs', '● Checking the instance', '● Still checking'], output: ['● The port does not answer.', '  HOPPER_DONE'] };
const DONE: FakeTurn = { output: ['● Used the new address. Done.', '  HOPPER_DONE'] };
const ASK: FakeTurn = { output: ['● Which region is the instance in?', '  HOPPER_QUESTION'] };
const NOTE_TEXT = 'The instance is i-0abc in eu-west-1; the port is 8443.';

/** The engine's side of the notes, as a stub: the notes waiting, and each take with how it was delivered. */
function notesStub(queued: string[] = []) {
  const takes: NoteDelivery[] = [];
  const notes: NonNullable<ExecutionContext['notes']> = {
    waiting: () => queued.length > 0,
    take(how) {
      if (queued.length === 0) return undefined;
      takes.push(how);
      const text = `[hopper] A person sent you a note:\n\n${queued.splice(0).join('\n\n')}\n\n[hopper] Go on with the job.`;
      return text;
    },
  };
  return { notes, takes, queued };
}

describe('herdr-claude executor: notes to a running job', () => {
  it('a note sent while the turn works goes in once the turn ends, not before; the job goes on and finishes', async () => {
    const { herdr, executor } = setup({ turns: [LONG, DONE] });
    const stub = notesStub();
    const base = contextFor(jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }));
    // The person sends the note while the job shows its first step.
    const ctx: ExecutionContext = { ...base.ctx, notes: stub.notes, progress: (m, t) => { base.ctx.progress(m, t); if (m === '● Reading the logs' && stub.takes.length === 0) stub.queued.push(NOTE_TEXT); } };
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished', result: { summary: 'Used the new address. Done.' } });
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toContain(NOTE_TEXT);
    expect(stub.takes).toEqual(['turn']);
    // Typed in only after the first turn showed its end.
    const screen = herdr.screen('w1:p1');
    expect(screen.indexOf('The port does not answer.')).toBeLessThan(screen.indexOf(NOTE_TEXT));
  });

  it('a job idle on its background work gets the note at once: no nudge, no wait for the work', async () => {
    const waiting: FakeTurn = { output: ['● Waiting for the port to answer.'], background: { work: '1 shell', polls: HOUR / 1000 } };
    const { herdr, clock, executor } = setup({ turns: [waiting, DONE] }, { idleNudgeMs: 20000 });
    const stub = notesStub();
    const base = contextFor(jobWith({ prompt: 'Reach the service', timeoutMs: 3 * HOUR }));
    const ctx: ExecutionContext = { ...base.ctx, notes: stub.notes, progress: (m, t) => { base.ctx.progress(m, t); if (m?.startsWith('waiting on background work')) stub.queued.push(NOTE_TEXT); } };
    expect(await executor.run(ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.prompts.map((p) => p.text)).not.toContain(STATUS_NOTE_NUDGE);
    expect(herdr.prompts[1]!.text).toContain(NOTE_TEXT);
    expect(clock.elapsed()).toBeLessThan(HOUR);
  });

  it('a turn that ends on a question keeps the notes: the run ends on the question, nothing is taken', async () => {
    const { herdr, executor } = setup({ turns: [ASK] });
    const stub = notesStub();
    const base = contextFor(jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }));
    const ctx: ExecutionContext = { ...base.ctx, notes: stub.notes, progress: (m, t) => { base.ctx.progress(m, t); if (m?.includes('Which region') && stub.queued.length === 0) stub.queued.push(NOTE_TEXT); } };
    expect(await executor.run(ctx)).toMatchObject({ kind: 'question', question: { text: 'Which region is the instance in?' } });
    expect(herdr.prompts).toHaveLength(1);
    expect(stub.takes).toEqual([]);
    expect(stub.queued).toEqual([NOTE_TEXT]);
  });

  it('a note waiting when the job starts goes in its task, before the protocol footer', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    const stub = notesStub([NOTE_TEXT]);
    const { ctx } = contextFor(jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }));
    expect(await executor.run({ ...ctx, notes: stub.notes })).toMatchObject({ kind: 'finished' });
    expect(herdr.prompts).toHaveLength(1);
    const task = herdr.prompts[0]!.text;
    expect(task.indexOf('Reach the service')).toBeLessThan(task.indexOf(NOTE_TEXT));
    expect(task.indexOf(NOTE_TEXT)).toBeLessThan(task.indexOf('HOPPER_DONE'));
    expect(stub.takes).toEqual(['start']);
  });

  it('a note waiting when the job resumes with an answer goes in with the answer', async () => {
    const { herdr, executor } = setup({ turns: [ASK, DONE] });
    const first = contextFor(jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }));
    expect((await executor.run(first.ctx)).kind).toBe('question');
    const job = jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }, { executorState: first.saved.at(-1) });
    const stub = notesStub([NOTE_TEXT]);
    expect(await executor.resume!({ ...contextFor(job).ctx, notes: stub.notes }, 'eu-west-1')).toMatchObject({ kind: 'finished' });
    expect(herdr.prompts).toHaveLength(2);
    expect(herdr.prompts[1]!.text).toMatch(/^eu-west-1\n\n/);
    expect(herdr.prompts[1]!.text).toContain(NOTE_TEXT);
    expect(stub.takes).toEqual(['resume']);
  });

  it('an answer that picks an option of a dialog goes alone: the note waits for the turn boundary', async () => {
    const dialog: FakeTurn = { output: ['● Allow the command?'], end: 'blocked', dialog: ['  ❯ 1. Yes', '    2. No'] };
    const { herdr, executor } = setup({ turns: [dialog, DONE, DONE] }, { yolo: false });
    const first = contextFor(jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }));
    expect((await executor.run(first.ctx)).kind).toBe('question');
    const job = jobWith({ prompt: 'Reach the service', timeoutMs: HOUR }, { executorState: first.saved.at(-1) });
    const stub = notesStub([NOTE_TEXT]);
    expect(await executor.resume!({ ...contextFor(job).ctx, notes: stub.notes }, '1')).toMatchObject({ kind: 'finished' });
    expect(herdr.texts.map((t) => t.text)).toContain('1');
    // The pick went into the dialog; the note followed at the end of that turn, as a turn of its own.
    expect(herdr.prompts.slice(1).map((p) => p.text)).toEqual([expect.stringContaining(NOTE_TEXT)]);
    expect(stub.takes).toEqual(['turn']);
  });
});
