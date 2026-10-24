import { describe, expect, it } from 'vitest';
import { contextFor, jobWith, LANE, LOCAL, setup } from './support.ts';

describe('herdr-claude executor: a dialog as a question', () => {
  // Issue #377: the question is the dialog; the tool output above it goes in recentOutput only.
  it('asks the dialog itself, not the screen above it', async () => {
    const dialog = ['● Bash(npm ci)', '  ⎿  added 226 packages in 7s', '● Bash(rm -rf build)', '  ⎿  Waiting…', '─────────', ' Bash command', '   rm -rf build', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    const { executor } = setup({ turns: [{ output: dialog, end: 'blocked' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked', text: 'Bash command\nrm -rf build\nDo you want to proceed?\n1. Yes\n2. No' } });
    if (out.kind === 'question') expect(out.question.recentOutput).toContain('added 226 packages');
  });

  // Issue #376: a dialog Claude Code denies by itself when its countdown runs out says so on the question.
  it('a dialog with a countdown: the question lapses when it runs out', async () => {
    const dialog = ['● Bash(rm -rf scratch)', ' Bash command', '   rm -rf scratch', ' ⚠ Claude Code will automatically deny this request in 1:59, to avoid blocking progress on an unattended session', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'];
    const { executor, clock } = setup({ turns: [{ output: dialog, end: 'blocked' }] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    const lapsesAt = new Date(clock.now().getTime() + 119_000).toISOString();
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked', lapsesAt } });
    expect(saved.at(-1)).toMatchObject({ lapsesAt });
  });

  it('a dialog without a countdown never lapses', async () => {
    const { executor } = setup({ turns: [{ output: [' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'], end: 'blocked' }] });
    const { ctx, saved } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out.kind === 'question' && out.question.lapsesAt).toBe(undefined);
    expect((saved.at(-1) as { lapsesAt?: string }).lapsesAt).toBeUndefined();
  });

  // Issue #376: Claude Code denies a dangerous-rm dialog by itself after two minutes; the escalation to
  // a human takes longer, so the countdown is off in every job's tab, and a payload cannot turn it on.
  it("turns off Claude Code's countdown that denies a dangerous rm by itself", async () => {
    const { herdr, executor } = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    await executor.run(contextFor(jobWith({ prompt: 'go', env: { CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '0' } })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '1' } });
  });

  // Issue #1502: terraform's version check writes ~/.terraform.d on the machine, which the credential check flags; off in
  // every job's tab, and a payload cannot turn it on.
  it("turns off terraform's version check, which writes into the machine's home", async () => {
    const { herdr, executor } = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    await executor.run(contextFor(jobWith({ prompt: 'go', env: { CHECKPOINT_DISABLE: '' } })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { CHECKPOINT_DISABLE: '1' } });
  });

  // Issue #2489: a Gradle daemon idles 3 hours after its build by default, and so outlived the job's work. Every job's tab
  // gives Gradle a 5-minute idle timeout, after the payload's own GRADLE_OPTS, which it keeps. Issue #2622: the build
  // defaults come first, so a project's own heap settings cannot multiply across lanes, and the payload's own win.
  it("gives Gradle's daemon a short idle timeout and capped build defaults, and keeps the payload's own GRADLE_OPTS", async () => {
    const caps = '-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx2g -Dorg.gradle.workers.max=2 -Dkotlin.compiler.execution.strategy=in-process';
    const idle = '-Dorg.gradle.daemon.idletimeout=300000';
    const plain = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    await plain.executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(plain.herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { GRADLE_OPTS: `${caps} ${idle}`, MAVEN_OPTS: '-Xmx2g' } });
    const own = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    await own.executor.run(contextFor(jobWith({ prompt: 'go', env: { GRADLE_OPTS: '-Xmx1g', MAVEN_OPTS: '-Xmx1g' } })).ctx);
    expect(own.herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { GRADLE_OPTS: `${caps} -Xmx1g ${idle}`, MAVEN_OPTS: '-Xmx2g -Xmx1g' } });
  });

  /** The Node report options (issue #2722) before the rest of NODE_OPTIONS. */
  const report = (id: string): string => `--report-on-fatalerror --report-compact --report-directory=/tmp/hopper-${id}`;

  // Issue #2721: Node sizes its default heap at a quarter of its scope's memory limit, so tsc ran out of heap in a job. A
  // machine whose jobs get a memory limit gives Node a heap of 75% of it; a payload's own heap size stays.
  it("gives Node a heap of the job's memory limit, and keeps the payload's own heap size", async () => {
    const machine = { ...LOCAL, resources: { cores: 8, memTotalBytes: 60 * 1024 ** 3, memAvailableBytes: 60 * 1024 ** 3 }, maxLanes: 6 };
    const limited = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    const first = contextFor(jobWith({ prompt: 'go' }), LANE, machine).ctx;
    await limited.executor.run(first);
    expect(limited.herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { NODE_OPTIONS: `${report(first.job.id)} --max-old-space-size=6912` } });
    const own = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    const second = contextFor(jobWith({ prompt: 'go', env: { NODE_OPTIONS: '--max-old-space-size=12000' } }), LANE, machine).ctx;
    await own.executor.run(second);
    expect(own.herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { NODE_OPTIONS: `${report(second.job.id)} --max-old-space-size=12000` } });
  });

  // Issue #2722: Node writes a report into the job's temp dir when its heap runs out; the payload's own NODE_OPTIONS after it.
  it("asks Node for a report on a heap that runs out, and keeps the payload's own NODE_OPTIONS after it", async () => {
    const own = setup({ turns: [{ output: ['● Done.', '  HOPPER_DONE'] }] });
    const { ctx } = contextFor(jobWith({ prompt: 'go', env: { NODE_OPTIONS: '--max-old-space-size=4096' } }));
    await own.executor.run(ctx);
    expect(own.herdr.calls.find((c) => c.method === 'createTab')!.args[0])
      .toMatchObject({ env: { NODE_OPTIONS: `${report(ctx.job.id)} --max-old-space-size=4096` } });
  });
});
