// Opt-in: HOPPER_REAL_HERDR=1. Runs a real Claude Code job in a throwaway herdr session
// (jh-test-<random>), asks one question, resumes with an answer, and checks the file it wrote.
// Costs a small Claude turn. Never touches the default herdr session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubbedEnv } from '../../src/executors/env.ts';
import { createHerdrClaudeExecutor, createHerdrCliClient } from '../../src/executors/herdr/index.ts';
import { claudeArgsFor, openPane, startClaude } from '../../src/executors/herdr/start.ts';
import { contextFor, jobWith } from './support.ts';

const REAL = process.env.HOPPER_REAL_HERDR === '1';
const BIN = process.env.HOPPER_HERDR_BIN ?? 'herdr';
const SESSION = `jh-test-${randomBytes(4).toString('hex')}`;

function herdrSync(args: string[]): string {
  return execFileSync(BIN, ['--session', SESSION, ...args], { env: scrubbedEnv(), encoding: 'utf8', timeout: 15000 });
}

describe.skipIf(!REAL)('herdr-claude against a real herdr and Claude (opt-in)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'jh-real-')));
    // The server's environment is what every pane inherits: scrub it, or a child-session marker leaks into Claude.
    spawn(BIN, ['--session', SESSION, 'server'], { detached: true, stdio: 'ignore', env: scrubbedEnv() }).unref();
    for (let i = 0; i < 50; i++) {
      try { herdrSync(['workspace', 'list']); return; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    throw new Error(`herdr session ${SESSION} did not come up`);
  }, 20000);

  afterAll(() => {
    try { herdrSync(['session', 'stop', SESSION, '--json']); } catch { /* already stopped */ }
    try { herdrSync(['session', 'delete', SESSION, '--json']); } catch { /* nothing to delete */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks a question, resumes with the answer, finishes, and the file exists', async () => {
    const executor = createHerdrClaudeExecutor({
      herdr: createHerdrCliClient({ bin: BIN, session: SESSION }),
      clock: { now: () => new Date() }, defaultCwd: dir, claudeArgs: ['--dangerously-skip-permissions'],
      trustWorkdir: true, pollMs: 1000, idleNudgeMs: 30000,
    });
    const id = randomUUID();
    const payload = {
      prompt: 'Ask me exactly one question: which single word should be written into answer.txt in the current directory. '
        + 'Do not create the file yet. After I answer, write exactly that word (no newline needed) into answer.txt and finish.',
      model: process.env.HOPPER_REAL_MODEL ?? 'sonnet', timeoutMs: 240000,
    };
    const first = contextFor(jobWith(payload, { id }));
    const asked = await executor.run(first.ctx);
    expect(asked.kind, JSON.stringify(asked)).toBe('question');
    console.warn('real herdr: question', JSON.stringify(asked.kind === 'question' ? asked.question.text : asked));
    console.warn('real herdr: progress', JSON.stringify(first.progress.map((p) => p.message)));

    const second = contextFor(jobWith(payload, { id, executorState: first.saved.at(-1) }));
    const done = await executor.resume!(second.ctx, 'pineapple');
    expect(done.kind, JSON.stringify(done)).toBe('finished');
    console.warn('real herdr: finished', JSON.stringify(done));
    const file = join(dir, 'answer.txt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('pineapple');

    await executor.cleanup!(second.ctx.job);
  }, 600000);

  it('keeps a job in its work tree: its temp files and scratchpad are in the git-ignored scratch dir', async () => {
    const tree = join(dir, 'tree');
    mkdirSync(tree);
    execFileSync('git', ['init', '-q', tree]);
    const executor = createHerdrClaudeExecutor({
      herdr: createHerdrCliClient({ bin: BIN, session: SESSION }),
      clock: { now: () => new Date() }, defaultCwd: tree, claudeArgs: ['--dangerously-skip-permissions'],
      trustWorkdir: true, pollMs: 1000, idleNudgeMs: 30000,
    });
    const payload = {
      prompt: 'Run `mktemp` once in the shell and write the path it prints into where.txt in the current directory. '
        + 'Then write the full path of your scratchpad directory into scratchpad.txt in the current directory, and finish.',
      model: process.env.JOB_HOPPER_REAL_MODEL ?? 'sonnet', timeoutMs: 240000,
    };
    const { ctx } = contextFor(jobWith(payload, { id: randomUUID() }));
    const done = await executor.run(ctx);
    expect(done.kind, JSON.stringify(done)).toBe('finished');
    const scratch = join(tree, '.hopper-scratch');
    expect(readFileSync(join(tree, 'where.txt'), 'utf8').trim().startsWith(`${scratch}/`)).toBe(true);
    expect(readFileSync(join(tree, 'scratchpad.txt'), 'utf8').trim().startsWith(`${scratch}/`)).toBe(true);
    // Only the job's own files show: the scratch dir ignores itself.
    expect(execFileSync('git', ['-C', tree, 'status', '--porcelain'], { encoding: 'utf8' }).split('\n').filter(Boolean).sort())
      .toEqual(['?? scratchpad.txt', '?? where.txt']);
    await executor.cleanup!(ctx.job);
  }, 600000);

  it('8 jobs started at once in fresh tabs all reach Claude ready (no start race)', async () => {
    const herdr = createHerdrCliClient({ bin: BIN, session: SESSION });
    const deps = {
      herdr, clock: { now: () => new Date() }, pollMs: 500, claudeArgs: claudeArgsFor(true, []), trustWorkdir: true, yolo: true, jobWorktrees: false,
      sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    };
    const ids = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `${i}0000000-0000-0000-0000-000000000000`);
    const panes: string[] = [];
    try {
      const outcomes = await Promise.all(ids.map(async (id, i) => {
        const { ctx } = contextFor(jobWith({ prompt: 'unused' }, { id }), `local/lane-${i}`);
        const state = await openPane(deps, ctx, dir, {});
        panes.push(state.paneId);
        return startClaude(deps, ctx, state, { prompt: 'unused', cwd: dir, env: {}, expectedMs: 1, timeoutMs: 1 });
      }));
      expect(outcomes).toEqual(ids.map(() => null));
      expect(new Set(panes).size).toBe(ids.length);
      for (const paneId of panes) {
        const a = JSON.parse(herdrSync(['pane', 'get', paneId])) as { result: { pane: { agent_status: string } } };
        expect(['idle', 'done']).toContain(a.result.pane.agent_status);
      }
    } finally {
      for (const paneId of panes) { try { herdrSync(['pane', 'close', paneId]); } catch { /* gone */ } }
    }
  }, 180000);
});
