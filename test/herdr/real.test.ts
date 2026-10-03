// Opt-in: JOB_HOPPER_REAL_HERDR=1. Runs a real Claude Code job in a throwaway herdr session
// (jh-test-<random>), asks one question, resumes with an answer, and checks the file it wrote.
// Costs a small Claude turn. Never touches the default herdr session.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHerdrClaudeExecutor, createHerdrCliClient, scrubbedEnv } from '../../src/executors/herdr/index.ts';
import { contextFor, jobWith } from './support.ts';

const REAL = process.env.JOB_HOPPER_REAL_HERDR === '1';
const BIN = process.env.JOB_HOPPER_HERDR_BIN ?? 'herdr';
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
      trustWorkdir: true, pollMs: 1000, idleQuestionMs: 30000,
    });
    const id = randomUUID();
    const payload = {
      prompt: 'Ask me exactly one question: which single word should be written into answer.txt in the current directory. '
        + 'Do not create the file yet. After I answer, write exactly that word (no newline needed) into answer.txt and finish.',
      model: process.env.JOB_HOPPER_REAL_MODEL ?? 'sonnet', timeoutMs: 240000,
    };
    const first = contextFor(jobWith(payload, { id }));
    const asked = await executor.run(first.ctx);
    expect(asked.kind, JSON.stringify(asked)).toBe('question');

    const second = contextFor(jobWith(payload, { id, executorState: first.saved.at(-1) }));
    const done = await executor.resume!(second.ctx, 'pineapple');
    expect(done.kind, JSON.stringify(done)).toBe('finished');
    const file = join(dir, 'answer.txt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('pineapple');

    await executor.cleanup!(second.ctx.job);
  }, 600000);
});
