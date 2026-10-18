// Opt-in, for the nightly run: HOPPER_ACCEPTANCE_TUI=1, with herdr and claude installed; HOPPER_ACCEPTANCE_TUI_DIR=<a short
// directory> where the temp dir's path is long (herdr's session socket lives in the home's config dir). Issue #1958: the real Claude
// Code TUI in a real herdr pane, against the fake model server with a dummy key, in a throwaway herdr session whose
// server, and so its pane, has an empty home (onboarding done, as the hopper's seed writes it: Claude's first-run
// screens check api.anthropic.com, which the fake server's proxy refuses). The hopper's own startup steps take Claude
// past each screen to its prompt, then one turn runs. Each screen it renders is checked against the screen the herdr
// fakes record (src/executors/herdr/fake-screens.ts); the test fails on a recorded line the real TUI no longer shows,
// and names it. Every capture is written to HOPPER_ACCEPTANCE_TUI_OUT (the nightly run's artifacts) when it is set.
// Never touches the default herdr session or the real home.
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHerdrCliClient, type HerdrCliClient } from '../../src/executors/herdr/index.ts';
import { CHROME, apiKeyScreen, bypassDialog, importsDialog, trustDialog } from '../../src/executors/herdr/fake-screens.ts';
import { isBypassDialog, isImportsDialog, isTrustDialog } from '../../src/executors/herdr/screen.ts';
import { isApiKeyScreen, promptShown, startupStep } from '../../src/executors/herdr/startup-screens.ts';
import { shellQuote } from '../../src/executors/ssh.ts';
import { startFakeModelServer, type FakeModelServer } from '../support/fake-model-server.ts';
import { REAL_AGENTS, realBin } from '../support/real-agents.ts';
import { screenDrift } from '../support/screen-drift.ts';

const CLAUDE = realBin('claude');
const BIN = process.env.HOPPER_HERDR_BIN ?? 'herdr';
const ON = process.env.HOPPER_ACCEPTANCE_TUI === '1';
const SESSION = `ja${randomBytes(2).toString('hex')}`;
/** The dummy key: the API-key screen shows its last 20 characters, as the recording does. */
const API_KEY = 'sk-ant-api03-hopper-test-0123456789abcdefghij';
/** How long one screen may take to come. */
const SCREEN_MS = 30_000;
const POLL_MS = 500;

let server: FakeModelServer;
let base: string;
let herdr: HerdrCliClient;
let env: Record<string, string>;
let shots = 0;
const herdrSync = (args: string[]): string => execFileSync(BIN, ['--session', SESSION, ...args], { env, encoding: 'utf8', timeout: 15_000 });
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Writes a capture where the nightly run keeps its artifacts. */
function keep(name: string, screen: string): void {
  const out = process.env.HOPPER_ACCEPTANCE_TUI_OUT;
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${String(++shots).padStart(2, '0')}-${name}.txt`), screen);
}

/** The pane's screen once `ready` holds for it; fails with the last screen when it does not in time. */
async function screenWhen(pane: string, ready: (s: string) => boolean, what: string): Promise<string> {
  let screen = '';
  for (let waited = 0; waited < SCREEN_MS; waited += POLL_MS) {
    screen = await herdr.read(pane, { source: 'visible', lines: 80 });
    if (ready(screen)) return screen;
    await sleep(POLL_MS);
  }
  keep(`timeout-${what}`, screen);
  throw new Error(`no ${what} in ${SCREEN_MS} ms; the screen:\n${screen}`);
}

describe.skipIf(!ON || !CLAUDE)('the real Claude Code TUI in a real herdr pane, against the fake model server (opt-in, nightly)', () => {
  beforeAll(async () => {
    server = await startFakeModelServer();
    // A short path: herdr's session socket lives under the home's config dir, and a socket path takes at most 108 bytes.
    base = mkdtempSync(join(process.env.HOPPER_ACCEPTANCE_TUI_DIR ?? tmpdir(), 't'));
    mkdirSync(join(base, 'r'), { mode: 0o700 });
    env = {
      HOME: base, XDG_CONFIG_HOME: join(base, 'c'), XDG_DATA_HOME: join(base, 'd'), XDG_STATE_HOME: join(base, 's'),
      XDG_RUNTIME_DIR: join(base, 'r'), SHELL: '/bin/bash', PATH: `${dirname(CLAUDE!)}:/usr/local/bin:/usr/bin:/bin`, TERM: 'xterm-256color',
    };
    // Onboarding done, nothing else: the work tree's trust, the key and bypass mode are Claude's to ask.
    writeFileSync(join(base, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', autoUpdates: false }));
    spawn(BIN, ['--session', SESSION, 'server'], { detached: true, stdio: 'ignore', env }).unref();
    for (let i = 0; i < 50; i++) {
      try { herdrSync(['workspace', 'list']); break; } catch { await sleep(200); }
    }
    herdr = createHerdrCliClient({ bin: BIN, session: SESSION, userEnv: env });
  }, 30_000);

  afterAll(async () => {
    try { herdrSync(['session', 'stop', SESSION, '--json']); } catch { /* already stopped */ }
    try { herdrSync(['session', 'delete', SESSION, '--json']); } catch { /* nothing to delete */ }
    await server?.close();
    if (base) rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('renders every screen the herdr fakes record, and the hopper\'s own steps take it to its prompt and through a turn', async () => {
    const work = join(realpathSync(base), 'w');
    mkdirSync(work);
    const ws = await herdr.run(['workspace', 'create', '--label', 'accept', '--cwd', work, '--no-focus']);
    const pane = (ws.root_pane as { pane_id: string }).pane_id;
    const claude = REAL_AGENTS.find((a) => a.agent === 'claude')!;
    const vars = { ...claude.env(server.url), ANTHROPIC_API_KEY: API_KEY };
    const launch = `clear; env ${Object.entries(vars).map(([k, v]) => shellQuote(`${k}=${v}`)).join(' ')} ${shellQuote(CLAUDE!)} --dangerously-skip-permissions`;
    await herdr.runInPane(pane, launch);

    // Each screen before the prompt: which recording it is, checked against it, then the hopper's step past it.
    // The imports dialog shows only where a CLAUDE.md above the temp dir imports files: it names the first of them.
    const RECORDED: { kind: string; is: (s: string) => boolean; lines: (s: string) => string[] }[] = [
      { kind: 'trust', is: (s) => isTrustDialog(s, work), lines: () => trustDialog(work) },
      { kind: 'imports', is: isImportsDialog, lines: (s) => importsDialog(/External imports:\s*\n\s*(\S+)/.exec(s)?.[1] ?? '') },
      { kind: 'apiKey', is: isApiKeyScreen, lines: apiKeyScreen },
      { kind: 'bypass', is: isBypassDialog, lines: bypassDialog },
    ];
    const policy = { cwd: work, trustWorkdir: true, yolo: true, unattended: true };
    const seen: string[] = [];
    for (;;) {
      const screen = await screenWhen(pane, (s) => promptShown(s) || startupStep(s, policy) !== undefined, 'startup screen or prompt');
      if (promptShown(screen)) break;
      const known = RECORDED.find((r) => r.is(screen));
      keep(known?.kind ?? 'unknown', screen);
      expect(known, `a startup screen the fakes do not record:\n${screen}`).toBeDefined();
      expect(screenDrift(known!.lines(screen), screen), `the ${known!.kind} screen no longer shows this recorded line`).toBeUndefined();
      const step = startupStep(screen, policy)!;
      expect(step, `the hopper would ask a person at the ${known!.kind} screen`).toHaveProperty('keys');
      seen.push(known!.kind);
      await herdr.sendKeys(pane, (step as { keys: string[] }).keys);
      await screenWhen(pane, (s) => !known!.is(s), `screen after ${known!.kind}`);
    }
    expect(seen.filter((k) => k !== 'imports')).toEqual(['trust', 'apiKey', 'bypass']);

    const prompt = await screenWhen(pane, promptShown, 'prompt');
    keep('prompt', prompt);
    expect(screenDrift(CHROME, prompt), 'the prompt no longer shows this recorded line').toBeUndefined();

    // One turn: the fake server answers, and the answer and the prompt come back on screen.
    server.script([{ text: 'Hello from the fake model.\n\nHOPPER_DONE' }]);
    await herdr.sendText(pane, 'Say hello.');
    await herdr.sendKeys(pane, ['enter']);
    const answered = await screenWhen(pane, (s) => s.includes('HOPPER_DONE') && promptShown(s), 'answer');
    keep('answer', answered);
    expect(answered).toContain('Hello from the fake model.');
    expect(screenDrift(CHROME, answered), 'the prompt after a turn no longer shows this recorded line').toBeUndefined();
    expect(server.left()).toBe(0);
  }, 180_000);
});
