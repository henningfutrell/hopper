// The Windows host of the crash harness (issue #1954, design.md "The crash harness"): a double at its seam
// (`WindowsStepHost`) that keeps what it did in files of a directory the test process owns (CRASH_WINDOWS), so what a
// killed hopper did on the host outlives it. Each run appends its step to `runs.jsonl` and leaves the host's scratch
// (`scratch/<host>`) until a sweep removes it. A command that says `hang` runs until it is stopped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WindowsStepHost } from '../../src/domain/ports.ts';

export function crashWindowsHost(dir: string): WindowsStepHost {
  return {
    async run(host, step, io) {
      mkdirSync(join(dir, 'scratch'), { recursive: true });
      writeFileSync(join(dir, 'scratch', host.name), step.id);
      appendFileSync(join(dir, 'runs.jsonl'), `${JSON.stringify({ step: step.id, host: host.name })}\n`);
      io.log(`ran ${step.command}\n`);
      if (step.command.includes('hang')) {
        await new Promise((r) => { io.signal.addEventListener('abort', r, { once: true }); });
        return { exit: 255, problem: 'stopped before it ended' };
      }
      await new Promise((r) => setTimeout(r, 20));
      return { exit: 0 };
    },
    async sweep(host) {
      rmSync(join(dir, 'scratch', host.name), { force: true });
    },
  };
}

/** The steps run on the host, in order: each run is one line. */
export function runsOn(dir: string): string[] {
  const file = join(dir, 'runs.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { step: string }).step) : [];
}

/** Whether the host keeps a scratch directory not swept. */
export const scratchLeft = (dir: string, host: string): boolean => existsSync(join(dir, 'scratch', host));
