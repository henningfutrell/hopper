// Issue #2622 part 3: the heavy steps' shims on a job's PATH, written by the guards step beside the podman and docker
// guards, run for real. A command whose words may make it heavy runs through the job's gate (`sh "$HOPPER_HEAVY"`), every
// other call as it is, and inside a heavy step, or with no gate, always as it is. Stand-ins for the commands and the gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guardsCommand, runtimeCommand } from '../../src/client/job-runtime.ts';
import { HEAVY_SHIMS } from '../../src/domain/heavy-steps.ts';
import { TERMINAL_LINE_MAX } from '../../src/executors/herdr/client.ts';

const JOB = 'job-2622-abcdef';
// Each stand-in command logs its name and arguments, and whether it runs inside a heavy step.
const FAKE = '#!/bin/sh\nprintf \'%s %s%s\\n\' "${0##*/}" "$*" "${HOPPER_HEAVY_HELD:+ (held)}" >> "$FAKE/calls"\n';
// The stand-in gate logs what it is asked to run, then runs it as the real client does.
const GATE = '#!/bin/sh\nprintf \'gate %s\\n\' "$*" >> "$FAKE/calls"\nHOPPER_HEAVY_HELD=1 exec "$@"\n';

let root: string;
let fake: string;
let scratch: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopper-heavy-shims-'));
  fake = join(root, 'bin');
  scratch = join(root, 'work', '.worktrees', '@scratch', JOB);
  for (const d of [fake, scratch]) mkdirSync(d, { recursive: true });
  for (const n of [...HEAVY_SHIMS.names, 'podman', 'docker']) writeFileSync(join(fake, n), FAKE, { mode: 0o755 });
  writeFileSync(join(root, 'gate'), GATE);
  writeFileSync(join(fake, 'calls'), '');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const env = (more: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOME: root, PATH: `${fake}${delimiter}/usr/bin${delimiter}/bin`, FAKE: fake, XDG_RUNTIME_DIR: join(root, 'missing'), HOPPER_HEAVY: join(root, 'gate'), ...more,
});
/** A job's shell: the runtime command with the heavy shims, then `script` in the same shell. */
function inJobShell(script: string, e = env()): string[] {
  const r = spawnSync('sh', ['-c', `${runtimeCommand(JOB, scratch, false, HEAVY_SHIMS)} >/dev/null; ${script}`], { encoding: 'utf8', env: e, timeout: 30000 });
  expect(r.status, r.stderr).toBe(0);
  return readFileSync(join(fake, 'calls'), 'utf8').split('\n').filter(Boolean).map((l) => l.replaceAll(`${fake}/`, ''));
}

describe('the heavy steps\' shims (issue #2622 part 3)', () => {
  it('the guards step with the shims still fits a terminal line, even with a long work tree', () => {
    const long = `/home/agent/${'w'.repeat(120)}/.worktrees/@scratch/${'0'.repeat(8)}-0000-0000-0000-000000000000`;
    expect(guardsCommand(long, HEAVY_SHIMS).length).toBeLessThanOrEqual(TERMINAL_LINE_MAX);
  });

  it('a build, an install, a browser run and an image build go through the gate; the other calls run as they are', () => {
    const calls = inJobShell('gradle test && mvn -q verify && npm install && npm run lint && yarn && pnpm --version'
      + ' && npx -y playwright test && npx vitest run && playwright install chromium && podman build -t x . && podman ps');
    expect(calls).toEqual([
      'gate gradle test', 'gradle test (held)',
      'gate mvn -q verify', 'mvn -q verify (held)',
      'gate npm install', 'npm install (held)',
      'npm run lint',
      'gate yarn', 'yarn  (held)',
      'pnpm --version',
      'gate npx -y playwright test', 'npx -y playwright test (held)',
      'npx vitest run',
      'gate playwright install chromium', 'playwright install chromium (held)',
      'gate podman build -t x .', 'podman build -t x . (held)',
      'podman ps',
    ]);
  });

  it('inside a heavy step, or with no gate, every call runs as it is', () => {
    expect(inJobShell('HOPPER_HEAVY_HELD=1 gradle test && HOPPER_HEAVY= npm ci')).toEqual(['gradle test (held)', 'npm ci']);
  });
});
