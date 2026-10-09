import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { STATUS_NOTE_NUDGE, protocolFooter } from '../../src/executors/herdr/index.ts';
import { CWD, JOB_ID, LANE, LOCAL, contextFor, jobWith, setup, until } from './support.ts';

/** The job's own scratch dir (issue #401): the reap removes it when the job ends. */
const SCRATCH = `${CWD}/.hopper-scratch/${JOB_ID}`;
const TMP = `/tmp/hopper-${JOB_ID}`;
const DONE = { output: ['● Wrote hello.txt.', '  HOPPER_DONE'] };

describe('herdr-claude executor: shape and validation', () => {
  const { executor } = setup();

  it('is herdr-claude, not idempotent, and resumes and cleans up', () => {
    expect(executor.name).toBe('herdr-claude');
    expect(executor.idempotent).toBe(false);
    expect(typeof executor.resume).toBe('function');
    expect(typeof executor.cleanup).toBe('function');
  });

  it.each([
    [{ prompt: 'go' }, null],
    [{ prompt: 'go', cwd: '/abs', model: 'opus', expectedMs: 1000, timeoutMs: 5000 }, null],
    [{ prompt: 'go', cwd: '~' }, null],
    [{ prompt: 'go', cwd: '~/x' }, null],
    [{}, 'prompt must be a non-empty string'],
    [{ prompt: '   ' }, 'prompt must be a non-empty string'],
    [{ prompt: 7 }, 'prompt must be a non-empty string'],
    [{ prompt: 'go', cwd: 'rel/dir' }, 'cwd must be an absolute path or start with ~'],
    [{ prompt: 'go', cwd: 3 }, 'cwd must be an absolute path or start with ~'],
    [{ prompt: 'go', model: 1 }, 'model must be a string'],
    [{ prompt: 'go', expectedMs: 0 }, 'expectedMs must be a positive number'],
    [{ prompt: 'go', timeoutMs: -1 }, 'timeoutMs must be a positive number'],
    [{ prompt: 'go', timeoutMs: 'x' }, 'timeoutMs must be a positive number'],
    [{ prompt: 'go', env: { HOPPER_REPO: 'o/r', _X1: '' } }, null],
    [{ prompt: 'go', env: 'x' }, 'env must be an object of string values'],
    [{ prompt: 'go', env: { A: 1 } }, 'env must be an object of string values'],
    [{ prompt: 'go', env: ['A=b'] }, 'env must be an object of string values'],
    [{ prompt: 'go', env: { 'bad-key': 'x' } }, 'env key bad-key must match ^[A-Z_][A-Z0-9_]*$'],
    [{ prompt: 'go', env: { '1A': 'x' } }, 'env key 1A must match ^[A-Z_][A-Z0-9_]*$'],
    [{ prompt: 'go', env: { lower: 'x' } }, 'env key lower must match ^[A-Z_][A-Z0-9_]*$'],
    [{ prompt: 'go', env: { A: 'x\ny' } }, 'env value of A must not contain a newline'],
    [{ prompt: 'go', env: { A: 'x\ry' } }, 'env value of A must not contain a newline'],
  ])('validate(%j) → %s', (payload, expected) => {
    expect(executor.validate(payload)).toBe(expected);
  });
});

describe('herdr-claude executor: run', () => {
  it('opens one tab in the hopper workspace, starts Claude, saves state before prompting', async () => {
    const { herdr, executor } = setup({ turns: [DONE] }, { claudeArgs: ['--dangerously-skip-permissions'] });
    const { ctx, saved, sessions } = contextFor(jobWith({ prompt: 'Write hello.txt', model: 'opus' }));
    await executor.run(ctx);
    expect(herdr.calls.find((c) => c.method === 'ensureWorkspace')!.args).toEqual(['hopper', CWD]);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args).toEqual([{ workspaceId: 'w1', cwd: CWD, label: `${LANE} · abcdef12`, env: { CLAUDE_CODE_TMPDIR: TMP, TMPDIR: TMP, HOPPER_JOB_ID: JOB_ID, CLAUDE_CODE_DISABLE_DANGEROUS_RM_TIMEOUT: '1' } }]);
    expect(herdr.agentStarts).toEqual([{ name: 'jh-abcdef12', paneId: 'w1:p1', args: ['--dangerously-skip-permissions', '--model', 'opus', '--session-id', sessions[0]!], timeoutMs: 60000 }]);
    // The session the hopper chose (issue #501), reported once Claude is up: a parked job resumes it.
    expect(sessions).toEqual([expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)]);
    expect(saved[0]).toEqual({ session: 'jh-test', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', agentName: 'jh-abcdef12', cwd: CWD, laneId: LANE });
    const order = herdr.calls.map((c) => c.method);
    expect(order.indexOf('createTab')).toBeLessThan(order.indexOf('startAgent'));
  });

  it('sets the payload env on the tab plus HOPPER_JOB_ID from the job, which a payload cannot override', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go', env: { HOPPER_REPO: 'o/r', HOPPER_JOB_ID: 'forged' } })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { HOPPER_REPO: 'o/r', HOPPER_JOB_ID: JOB_ID } });
  });

  it('keeps the job in its work tree: Claude\'s scratchpad and temp files point, through a short link (issue #506), at a scratch dir inside it, which a payload cannot move', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go', env: { TMPDIR: '/tmp', CLAUDE_CODE_TMPDIR: '/tmp' } })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ env: { CLAUDE_CODE_TMPDIR: TMP, TMPDIR: TMP } });
  });

  it('prepares the scratch dir in the pane before Claude starts, inside the work tree the shell enters, git-ignored by its own .gitignore', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(herdr.calls.find((c) => c.method === 'runInPane')!.args).toEqual(['w1:p1', `mkdir -p '${CWD}' && cd '${CWD}' && mkdir -p '${SCRATCH}' && printf '*\\n' > '${CWD}/.hopper-scratch/.gitignore' && ln -sfn '${SCRATCH}' '${TMP}' && [ "$(readlink '${TMP}')" = '${SCRATCH}' ] && printf 'hopper-scratch-%s\\n' ready || printf 'hopper-scratch-%s\\n' unusable`]);
    const order = herdr.calls.map((c) => c.method);
    expect(order.indexOf('runInPane')).toBeGreaterThan(order.indexOf('createTab'));
    expect(order.indexOf('runInPane')).toBeLessThan(order.indexOf('startAgent'));
  });

  it('runs the scratch command again until the shell has run it: a fresh shell can drop what is typed before its prompt', async () => {
    const { herdr, executor } = setup({ turns: [DONE], shellDropsRuns: 2 });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).toMatchObject({ kind: 'finished' });
    expect(herdr.calls.filter((c) => c.method === 'runInPane' && String(c.args[1]).includes('hopper-scratch'))).toHaveLength(3);
    expect(herdr.calls.filter((c) => c.method === 'waitOutput' && c.args[1] === 'hopper-scratch-ready').map((c) => c.args.slice(1))).toEqual(Array(3).fill(['hopper-scratch-ready', 1000]));
  });

  it('fails the job, panes closed, when the shell never runs the scratch command in 3 starts (issue #462)', async () => {
    const { herdr, executor } = setup({ turns: [DONE], shellDropsRuns: 1000 });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx))
      .toEqual({ kind: 'failed', error: `claude did not start in 3 attempts: pane w1:p3 never ran the scratch dir command within 60000 ms` });
    expect(herdr.agentStarts).toEqual([]);
    expect(herdr.closed).toEqual(['w1:p1', 'w1:p2', 'w1:p3']);
  });

  it('quotes a work tree path for the shell', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go' }), LANE, { ...LOCAL, workTree: "/w/it's here" }).ctx);
    expect(herdr.calls.find((c) => c.method === 'runInPane')!.args[1]).toBe(`mkdir -p '/w/it'\\''s here' && cd '/w/it'\\''s here' && mkdir -p '/w/it'\\''s here/.hopper-scratch/${JOB_ID}' && printf '*\\n' > '/w/it'\\''s here/.hopper-scratch/.gitignore' && ln -sfn '/w/it'\\''s here/.hopper-scratch/${JOB_ID}' '${TMP}' && [ "$(readlink '${TMP}')" = '/w/it'\\''s here/.hopper-scratch/${JOB_ID}' ] && printf 'hopper-scratch-%s\\n' ready || printf 'hopper-scratch-%s\\n' unusable`);
  });

  it('every job prompt names its work tree and keeps the work in it', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go', cwd: '/w/repo' })).ctx);
    const sent = herdr.prompts[0]!.text;
    expect(sent).toContain("[hopper work tree] This job's work tree is /w/repo.");
    expect(sent).toContain('Never make or work in a copy of the code outside it, under /tmp or anywhere else.');
  });

  it('reports its work tree, ~ expanded, so the lane running it shows where it works (issue #166)', async () => {
    const { executor } = setup({ turns: [DONE] });
    const { ctx, workTrees } = contextFor(jobWith({ prompt: 'go', cwd: '~/proj' }));
    await executor.run(ctx);
    expect(workTrees).toEqual([`${homedir()}/proj`]);
  });

  it('reports its work tree when reattached too, so a job started before a restart or an update shows where it works (issue #166)', async () => {
    const { executor } = setup({ turns: [DONE] });
    const { ctx, workTrees } = contextFor(jobWith({ prompt: 'go', cwd: '/w/repo' }));
    await executor.reattach!(ctx);
    expect(workTrees).toEqual(['/w/repo']);
  });

  it('expands ~ in the cwd', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'go', cwd: '~/proj' })).ctx);
    expect(herdr.calls.find((c) => c.method === 'createTab')!.args[0]).toMatchObject({ cwd: `${homedir()}/proj` });
  });

  it('every job prompt carries the publishing rule: neutral GitHub text, no person, PII or machine details', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run(contextFor(jobWith({ prompt: 'Write hello.txt' })).ctx);
    const sent = herdr.prompts[0]!.text;
    expect(sent).toContain('[hopper publishing rule]');
    for (const term of ['Never quote or name the repository owner', 'email addresses', 'IP addresses', 'hostnames', 'tailnet names', 'home directory paths', 'usernames', 'machine or pane ids', 'port numbers of local machines', 'tokens or secrets', 'in neutral terms']) {
      expect(sent).toContain(term);
    }
    expect(sent).not.toMatch(/comment/i);
  });

  it('every job prompt carries the job rules it starts with in place of the default (issue #172)', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    await executor.run({ ...contextFor(jobWith({ prompt: 'Write hello.txt', cwd: CWD })).ctx, jobRules: 'Always write in French.' });
    expect(herdr.prompts[0]!.text).toBe(`Write hello.txt\n\n${protocolFooter(CWD, 'Always write in French.', SCRATCH)}`);
    expect(herdr.prompts[0]!.text).not.toContain('[hopper publishing rule]');
  });

  it('sends the prompt exactly once, with the protocol footer', async () => {
    const { herdr, executor } = setup({ turns: [{ steps: ['● a', '● b', '● c'], ...DONE }] });
    await executor.run(contextFor(jobWith({ prompt: 'Write hello.txt' })).ctx);
    expect(herdr.prompts).toEqual([{ name: 'jh-abcdef12', text: `Write hello.txt\n\n${protocolFooter(CWD, undefined, SCRATCH)}` }]);
  });

  it('finishes on HOPPER_DONE with the final assistant text and the pane id', async () => {
    const { executor } = setup({ turns: [DONE] });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx))
      .toEqual({ kind: 'finished', result: { summary: 'Wrote hello.txt.', paneId: 'w1:p1' } });
  });

  it('fails on HOPPER_FAILED with its reason', async () => {
    const { executor } = setup({ turns: [{ output: ['● I cannot.', '  HOPPER_FAILED no network access'] }] });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).toEqual({ kind: 'failed', error: 'no network access', tail: expect.stringContaining('HOPPER_FAILED no network access') });
  });

  it('asks on HOPPER_QUESTION, keeps the pane, and frees the lane mapping', async () => {
    const { herdr, executor } = setup({ turns: [{ output: ['● Which language?', '  HOPPER_QUESTION'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { text: 'Which language?', detectedBy: 'marker' } });
    expect(out.kind === 'question' && out.question.recentOutput).toContain('Which language?');
    expect(herdr.closed).toEqual([]);
    expect(executor.lanePanes().has(LANE)).toBe(false);
  });

  it('a marker printed while Claude is still working is not an outcome (turn must end)', async () => {
    const { executor } = setup({ turns: [{ steps: ['● I will end with', '  HOPPER_DONE', '● Bash(make)'], output: ['● Which target?', '  HOPPER_QUESTION'] }] });
    expect(await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx)).toMatchObject({ kind: 'question', question: { text: 'Which target?' } });
  });

  it('asks when Claude shows a question dialog (blocked)', async () => {
    const { executor } = setup({ turns: [{ output: ['● Pick one', '  ❯ 1. Red', '    2. Blue'], end: 'blocked' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('question');
    if (out.kind !== 'question') return;
    expect(out.question.detectedBy).toBe('blocked');
    expect(out.question.text).toContain('2. Blue');
  });

  // Issue #163: a turn that ends without a marker is a status note, never a question.
  it('a status note opens no question: after idleNudgeMs idle the hopper nudges, and the job goes on', async () => {
    const note = { output: ['● Tests are running in the background; I will report when they finish.'] };
    const { herdr, clock, executor } = setup({ turns: [note, DONE] }, { idleNudgeMs: 20000 });
    const { ctx, progress, saved } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out).toMatchObject({ kind: 'finished', result: { summary: expect.stringContaining('Wrote hello.txt.') } });
    expect(herdr.prompts.map((p) => p.text)).toEqual([expect.stringContaining('go'), STATUS_NOTE_NUDGE]);
    expect(clock.elapsed()).toBeGreaterThanOrEqual(20000);
    expect(progress.map((p) => p.message)).toContain('Tests are running in the background; I will report when they finish.');
    expect(saved.at(-1)).toMatchObject({ turn: { anchor: STATUS_NOTE_NUDGE } });
  });

  it('a question asked without the marker is nudged, and asked again with it', async () => {
    const { executor } = setup({ turns: [{ output: ['● I made the change. Anything else?'] }, { output: ['● Should I also update the README?', '  HOPPER_QUESTION'] }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'marker', text: 'Should I also update the README?' } });
  });

  it('fails when Claude exits, with its last output', async () => {
    const { executor } = setup({ turns: [{ output: ['● Segfault in the matrix'], end: 'exit' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind).toBe('failed');
    expect(out.kind === 'failed' && out.error).toMatch(/^claude exited/);
    expect(out.kind === 'failed' && out.error).toContain('Segfault in the matrix');
  });

  it('times out per call: interrupts, exits Claude, closes the pane', async () => {
    const { herdr, clock, executor } = setup({ turns: [{ output: [], end: 'working' }] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go', timeoutMs: 5000 })).ctx);
    expect(out).toEqual({ kind: 'failed', error: 'timed out' });
    expect(clock.elapsed()).toBeLessThan(10000);
    expect(herdr.keys).toEqual([{ paneId: 'w1:p1', keys: ['esc'] }, { paneId: 'w1:p1', keys: ['ctrl+c', 'ctrl+c'] }]);
    expect(herdr.closed).toEqual(['w1:p1']);
  });

  it('reports progress on each new assistant line, capped at 0.9 and non-decreasing', async () => {
    const { executor } = setup({ turns: [{ steps: ['● Reading files', '● Writing hello.txt'], ...DONE }] });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go', expectedMs: 2000 }));
    await executor.run(ctx);
    const messages = progress.map((p) => p.message);
    expect(messages).toEqual(expect.arrayContaining(['Reading files', 'Writing hello.txt']));
    expect(progress.every((p) => p.fraction >= 0 && p.fraction <= 0.9)).toBe(true);
    expect(progress.map((p) => p.fraction)).toEqual([...progress.map((p) => p.fraction)].sort((a, b) => a - b));
  });

  it('maps its lane to its pane while running', async () => {
    const { herdr, executor } = setup({ turns: [{ steps: ['● a', '● b', '● c', '● d'], ...DONE }] });
    const running = executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    await until(() => herdr.prompts.length === 1);
    const seen = executor.lanePanes().get(LANE);
    await running;
    expect(seen).toBe('w1:p1');
    expect(executor.lanePanes().has(LANE)).toBe(false);
  });

  it('accepts the folder-trust dialog for its own cwd and says so', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, turns: [DONE] });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(ctx)).kind).toBe('finished');
    expect(herdr.keys[0]).toEqual({ paneId: 'w1:p1', keys: ['down', 'enter'] });
    expect(progress.map((p) => p.message)).toContain(`trusted workdir ${CWD}`);
  });

  // Issue #534: a dialog the hopper may not answer is asked of a person, its options numbered; the pane stays.
  it('never answers a trust dialog naming another path itself: asked as a question, with its options, pane kept', async () => {
    const { herdr, executor } = setup({ trustDialogFor: '/somewhere/else', turns: [DONE] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out).toMatchObject({ kind: 'question', question: { detectedBy: 'blocked' } });
    expect(out.kind === 'question' && out.question.text).toContain('Quick safety check');
    expect(out.kind === 'question' && out.question.text).toContain('1. No, exit\n2. Yes, I trust this folder');
    expect(herdr.keys.some((k) => k.keys.includes('down'))).toBe(false);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.closed).toEqual([]);
  });

  // Issue #267: a yolo instance starts Claude with every permission granted; its warning never holds the job.
  it.each(['not-ready', 'started'] as const)('yolo: accepts the bypass permissions warning at startup (%s) and says so', async (when) => {
    const { herdr, executor } = setup({ bypassDialog: when, turns: [DONE] }, { yolo: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    const out = await executor.run(ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.keys[0]).toEqual({ paneId: 'w1:p1', keys: ['down', 'enter'] });
    expect(progress.map((p) => p.message)).toContain('accepted bypass permissions mode');
    expect(herdr.prompts).toHaveLength(1);
  });

  it('yolo: the trust dialog, then the bypass permissions warning: both answered, once each', async () => {
    const { herdr, executor } = setup({ trustDialogFor: CWD, bypassDialog: 'not-ready', turns: [DONE] }, { yolo: true });
    const { ctx, progress } = contextFor(jobWith({ prompt: 'go' }));
    expect((await executor.run(ctx)).kind).toBe('finished');
    expect(herdr.keys.map((k) => k.keys)).toEqual([['down', 'enter'], ['down', 'enter']]);
    expect(progress.map((p) => p.message)).toEqual(expect.arrayContaining([`trusted workdir ${CWD}`, 'accepted bypass permissions mode']));
  });

  it('not yolo: the bypass permissions warning is never accepted by the hopper: asked as a question, pane kept', async () => {
    const { herdr, executor } = setup({ bypassDialog: 'not-ready', turns: [DONE] }, { yolo: false });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'question' && out.question.text).toContain('Bypass Permissions mode');
    expect(herdr.keys.some((k) => k.keys.includes('down'))).toBe(false);
    expect(herdr.prompts).toEqual([]);
    expect(herdr.closed).toEqual([]);
  });

  it('asks any other startup block as a question, the dialog its text', async () => {
    const { executor } = setup({ startupBlockedBy: ['─'.repeat(40), ' Claude Code needs to update', '', ' ❯ 1. Update now', '   2. Exit', '', ' Enter to confirm · Esc to cancel'] });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'question' && out.question.text).toContain('needs to update');
  });

  it('never rejects: a herdr error becomes failed', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.failNext('createTab', 'workspace_not_found');
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/workspace_not_found/);
  });

  it('waits for the pane shell: retries agent start while herdr says not an available shell', async () => {
    const { herdr, executor } = setup({ turns: [DONE], shellNotReadyStarts: 3 });
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind, JSON.stringify(out)).toBe('finished');
    expect(herdr.calls.filter((c) => c.method === 'startAgent')).toHaveLength(4);
    expect(herdr.agentStarts).toHaveLength(1);
  });

  it('gives up at the start deadline of each of its 3 starts when the shell never comes (issue #462): failed, panes closed', async () => {
    const { herdr, clock, executor } = setup({ turns: [DONE], shellNotReadyStarts: Infinity });
    const t0 = clock.now().getTime();
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/shell/);
    // Three start deadlines, and the pauses between them: 10 to 15 s, then 30 to 45 s.
    expect(clock.now().getTime() - t0).toBeGreaterThanOrEqual(3 * 60000 + 40000);
    expect(clock.now().getTime() - t0).toBeLessThan(3 * 62000 + 60000);
    expect(herdr.closed).toEqual(['w1:p1', 'w1:p2', 'w1:p3']);
    expect(herdr.prompts).toEqual([]);
  });

  it('does not retry any other agent start error', async () => {
    const { herdr, executor } = setup({ turns: [DONE] });
    herdr.failNext('startAgent', 'pane_not_found');
    const out = await executor.run(contextFor(jobWith({ prompt: 'go' })).ctx);
    expect(out.kind === 'failed' && out.error).toMatch(/pane_not_found/);
    expect(herdr.calls.filter((c) => c.method === 'startAgent')).toHaveLength(1);
  });
});
