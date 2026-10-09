// Claude at a dialog before the hopper sent it anything (issue #534): a question to a person, never a failure.
// Seen live: the folder-trust dialog answered, Claude up, then a dialog of its own; the job failed in 16 s with
// "herdr: agent … is blocked and requires interactive input" and its pane was torn down.
import { describe, expect, it } from 'vitest';
import { CWD, contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };
const NOTICE = ['─'.repeat(40), ' Claude Code has switched to a new default model', '', ' ❯ 1. Keep the new default', '   2. Choose another model', '', ' Enter to confirm · Esc to cancel'];
const UPDATE = ['─'.repeat(40), ' Claude Code needs to update', '', ' ❯ 1. Update now', '   2. Later', '', ' Enter to confirm · Esc to cancel'];

/** Run to the dialog's question; the job as the engine hands it to resume. */
async function onDialog(o: Parameters<typeof setup>[0]) {
  const s = setup(o);
  const first = contextFor(jobWith({ prompt: 'go' }));
  const out = await s.executor.run(first.ctx);
  const job = jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1), status: 'running' });
  return { ...s, first, out, job };
}

describe('herdr-claude executor: a dialog before anything was sent (issue #534)', () => {
  it('the trust dialog answered, then a dialog of Claude\'s: the job asks it, with its choices, and keeps its pane', async () => {
    const { herdr, first, out } = await onDialog({ trustDialogFor: CWD, lateDialog: { lines: NOTICE, after: 2 }, turns: [DONE] });
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked' } });
    const text = out.kind === 'question' ? out.question.text : '';
    expect(text).toContain('Claude Code has switched to a new default model');
    expect(text).toContain('1. Keep the new default');
    expect(text).toContain('2. Choose another model');
    expect(herdr.closed).toEqual([]);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.keys.some((k) => k.keys.includes('esc'))).toBe(false);
    expect(first.progress.map((p) => p.message)).toContain(`trusted workdir ${CWD}`);
  });

  it('the answer picks the option, then the job gets its task and runs to the end', async () => {
    const { herdr, executor, job } = await onDialog({ trustDialogFor: CWD, lateDialog: { lines: NOTICE, after: 2 }, turns: [DONE] });
    const { ctx, progress } = contextFor(job);
    const out = await executor.resume!(ctx, '1');
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.texts.map((t) => t.text)).toContain('1');
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]!.text).toMatch(/^go\n\n/);
    expect(herdr.prompts[0]!.text).toContain('HOPPER_DONE');
    expect(progress.map((p) => p.message)).toContain('picked option 1 of the dialog');
  });

  it('an answer that names no option of the dialog asks again, nothing typed', async () => {
    const { herdr, executor, job } = await onDialog({ lateDialog: { lines: NOTICE, after: 1 }, turns: [DONE] });
    const out = await executor.resume!(contextFor(job).ctx, 'whatever works');
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked' } });
    expect(out.kind === 'question' && out.question.text).toContain('names none of its options');
    expect(herdr.texts).toEqual([]);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.closed).toEqual([]);
  });

  it('a dialog at startup the hopper may not answer: a question, not a failure, in the first pane', async () => {
    const { herdr, executor, job, out } = await onDialog({ startupBlockedBy: UPDATE, turns: [DONE] });
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked' } });
    expect(out.kind === 'question' && out.question.text).toContain('2. Later');
    expect(herdr.calls.filter((c) => c.method === 'createTab')).toHaveLength(1);
    expect(herdr.closed).toEqual([]);
    expect((await executor.resume!(contextFor(job).ctx, 'Later')).kind).toBe('finished');
    expect(herdr.texts.map((t) => t.text)).toContain('2');
    expect(herdr.prompts).toHaveLength(1);
  });

  it('herdr refusing the prompt because Claude is blocked is no failure: the prompt goes once Claude is ready', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.failNext('prompt', 'agent_blocked');
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.prompts).toHaveLength(1);
  });

  it('answered straight in the pane: the job sees it and gets its task', async () => {
    const { herdr, executor, job } = await onDialog({ lateDialog: { lines: NOTICE, after: 1 }, turns: [DONE] });
    const pane = (job.executorState as { paneId: string }).paneId;
    expect(await executor.answeredInPane!(job)).toBeNull();
    await herdr.sendText(pane, '1');
    const seen = await executor.answeredInPane!(job);
    expect(seen).not.toBeNull();
    const out = await executor.reattach!(contextFor({ ...job, executorState: seen!.executorState }).ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.prompts).toHaveLength(1);
    expect(herdr.prompts[0]!.text).toMatch(/^go\n\n/);
  });

  it('never answers its own trust dialog when trustWorkdir is false: a person does, and the job runs', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, turns: [DONE] }, { trustWorkdir: false });
    const first = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(first.ctx)).kind).toBe('question');
    expect(herdr.prompts).toEqual([]);
    const job = jobWith({ prompt: 'go' }, { executorState: first.saved.at(-1), status: 'running' });
    const { ctx, progress } = contextFor(job);
    expect((await executor.resume!(ctx, 'Yes, I trust this folder')).kind).toBe('finished');
    expect(herdr.keys.map((k) => k.keys)).toEqual([['down', 'enter']]);
    expect(progress.map((p) => p.message)).toContain('picked option 2 of the dialog');
    expect(herdr.prompts).toHaveLength(1);
  });
});
