// Claude's external CLAUDE.md imports dialog at startup (issue #518): the herdr-claude executor, over the fake herdr.
import { describe, expect, it } from 'vitest';
import { CWD, contextFor, jobWith, setup } from './support.ts';

const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };

describe('herdr-claude executor: the external CLAUDE.md imports dialog', () => {
  // Issue #518: a job worktree is inside the work tree, so the work tree's CLAUDE.md importing its AGENTS.md
  // imports a file outside the job's cwd, and Claude asks first. The owner trusts the work tree (trustWorkdir).
  it('the external CLAUDE.md imports dialog, the work tree trusted: allowed, between the trust dialog and the bypass warning', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, importsDialog: '/home/dev/work/AGENTS.md', bypassDialog: 'not-ready', turns: [DONE] }, { yolo: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(ctx)).kind).toBe('finished');
    expect(herdr.keys.map((k) => k.keys)).toEqual([['down', 'enter'], ['down', 'enter'], ['down', 'enter']]);
    expect(progress.map((p) => p.message)).toEqual(expect.arrayContaining([`trusted workdir ${CWD}`, 'allowed the external CLAUDE.md imports of the trusted work tree', 'accepted bypass permissions mode']));
    expect(herdr.prompts).toHaveLength(1);
  });

  // Issue #534: a dialog the hopper may not answer goes to a person, never fails the job.
  it('the external CLAUDE.md imports dialog, the work tree not trusted: asked as a question, nothing answered', async () => {
    const { herdr, executor } = setup({ importsDialog: '/home/dev/work/AGENTS.md', turns: [DONE] }, { trustWorkdir: false });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked' } });
    expect(out.kind === 'question' && out.question.text).toContain('Allow external CLAUDE.md file imports?');
    expect(herdr.closed).toEqual([]);
    expect(herdr.keys.some((k) => k.keys.includes('down'))).toBe(false);
    expect(herdr.prompts).toEqual([]);
  });
});
