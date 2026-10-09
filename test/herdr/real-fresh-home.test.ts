// Opt-in: HOPPER_REAL_CLAUDE=<the claude binary>; HOPPER_REAL_FRESH_DIR=<a short directory> where the temp dir's
// path is long (herdr's session socket lives in the home's config dir, and a socket path takes at most 108 bytes). A fresh container's empty home (issue #533), against a real herdr
// and the real Claude Code: a throwaway herdr session whose server, and so every pane, has a new empty HOME. Claude
// starts in a job worktree whose work tree's CLAUDE.md imports a file outside it (the #518 case) with no key pressed;
// with no credential, the job asks it as a question (issue #534), never a wait. Claude is given a stand-in API key and never
// reaches the API. Never touches the default herdr session or the real home.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHerdrClaudeExecutor, createHerdrCliClient, type HerdrClient } from '../../src/executors/herdr/index.ts';
import { claudeArgsFor, openPane, startClaude, type StartDeps } from '../../src/executors/herdr/start.ts';
import { promptShown } from '../../src/executors/herdr/startup-screens.ts';
import { LOCAL, contextFor, jobWith } from './support.ts';

const CLAUDE = process.env.HOPPER_REAL_CLAUDE;
const BIN = process.env.HOPPER_HERDR_BIN ?? 'herdr';
const SESSION = `jf${randomBytes(2).toString('hex')}`;
/** A stand-in: Claude records its last 20 characters as approved, and never gets as far as using it. */
const API_KEY = 'sk-ant-api03-hopper-test-0123456789abcdefghij';

describe.skipIf(!CLAUDE)('a fresh home: Claude starts with no key press (issue #533, opt-in)', () => {
  let base: string;
  let dir: string;
  let home: string;
  let env: Record<string, string>;
  const herdrSync = (args: string[]): string => execFileSync(BIN, ['--session', SESSION, ...args], { env: { ...env, TERM: 'xterm-256color' }, encoding: 'utf8', timeout: 15000 });

  beforeAll(async () => {
    // The empty home, by a short path: the session socket is under its config dir.
    base = mkdtempSync(join(process.env.HOPPER_REAL_FRESH_DIR ?? tmpdir(), 'f'));
    home = base;
    dir = realpathSync(base);
    mkdirSync(join(home, 'r'), { mode: 0o700 });
    env = {
      HOME: home, XDG_CONFIG_HOME: join(home, 'c'), XDG_DATA_HOME: join(home, 'd'), XDG_STATE_HOME: join(home, 's'),
      XDG_RUNTIME_DIR: join(home, 'r'), SHELL: '/bin/bash', PATH: `${dirname(CLAUDE!)}:/usr/local/bin:/usr/bin:/bin`,
    };
    spawn(BIN, ['--session', SESSION, 'server'], { detached: true, stdio: 'ignore', env: { ...env, TERM: 'xterm-256color' } }).unref();
    for (let i = 0; i < 50; i++) {
      try { herdrSync(['workspace', 'list']); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    // The work tree: a repository whose CLAUDE.md imports its AGENTS.md; the job's worktree lies inside it (issue #518).
    const tree = join(dir, 'work');
    mkdirSync(tree);
    writeFileSync(join(tree, 'AGENTS.md'), '# rules\n');
    writeFileSync(join(tree, 'CLAUDE.md'), '@AGENTS.md\n');
    const git = (...args: string[]) => execFileSync('git', ['-C', tree, ...args], { env: { ...env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  }, 30000);

  afterAll(() => {
    try { herdrSync(['session', 'stop', SESSION, '--json']); } catch { /* already stopped */ }
    try { herdrSync(['session', 'delete', SESSION, '--json']); } catch { /* nothing to delete */ }
    rmSync(base, { recursive: true, force: true });
  });

  /** Starts Claude for a new job in the work tree; the keys the hopper sent, and the screen. */
  async function start(id: string, paneEnv: Record<string, string>) {
    const real = createHerdrCliClient({ bin: BIN, session: SESSION, userEnv: env });
    const keys: string[][] = [];
    const herdr: HerdrClient = { ...real, sendKeys: async (pane, k) => { keys.push(k); return real.sendKeys(pane, k); } };
    const deps: StartDeps = {
      herdr, clock: { now: () => new Date() }, sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), pollMs: 500,
      claudeArgs: claudeArgsFor(true, []), trustWorkdir: true, yolo: true, unattended: true, jobWorktrees: true, sharedDependencies: false,
    };
    const work = join(dir, 'work');
    const { ctx, progress } = contextFor(jobWith({ prompt: 'unused' }, { id }), 'local/lane-1', { ...LOCAL, workTree: work });
    const state = await openPane(deps, ctx, work, paneEnv);
    const out = await startClaude(deps, ctx, state, { prompt: 'unused', cwd: work, env: {}, expectedMs: 1, timeoutMs: 1 });
    const screen = await real.read(state.paneId, { source: 'visible', lines: 60 });
    return { out, keys, screen, progress: progress.map((p) => p.message) };
  }

  it('an empty home: the config is seeded and Claude reaches its prompt in a job worktree, no key pressed', async () => {
    const { out, keys, screen, progress } = await start('a0000000-0000-0000-0000-000000000533', { ANTHROPIC_API_KEY: API_KEY });
    expect(out, screen).toBeNull();
    expect(keys).toEqual([]);
    expect(promptShown(screen)).toBe(true);
    expect(progress).toContain("seeded claude's config: the machine had none");
    expect(JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'))).toMatchObject({ hasCompletedOnboarding: true });
  }, 180000);

  it('no credential at all: the job asks it as a question, never a wait, nothing pressed and nothing sent', async () => {
    const real = createHerdrCliClient({ bin: BIN, session: SESSION, userEnv: env });
    const keys: string[][] = [];
    const prompts: string[] = [];
    const herdr: HerdrClient = {
      ...real, sendKeys: async (pane, k) => { keys.push(k); return real.sendKeys(pane, k); }, prompt: async (name, text) => { prompts.push(text); return real.prompt(name, text); },
    };
    // A config dir of its own (Claude's own variable): the first test's Claude has written its home's config.
    const executor = createHerdrClaudeExecutor({
      herdr, clock: { now: () => new Date() }, claudeArgs: claudeArgsFor(true, []), trustWorkdir: true, yolo: true, unattended: true, jobWorktrees: true, pollMs: 500, idleNudgeMs: 60000,
      paneEnv: { CLAUDE_CONFIG_DIR: join(home, 'n') },
    });
    const { ctx } = contextFor(jobWith({ prompt: 'unused', timeoutMs: 120000 }, { id: 'b0000000-0000-0000-0000-000000000533' }), 'local/lane-1', { ...LOCAL, workTree: join(dir, 'work') });
    const out = await executor.run(ctx);
    expect(out.kind === 'question' && out.question.text).toContain('Claude is not signed in on this machine');
    expect(keys).toEqual([]);
    expect(prompts).toEqual([]);
  }, 180000);
});
