// The Windows host of the crash harness (issue #1954, design.md "The crash harness"): a double at its seam
// (`WindowsStepHost`) that keeps what it did in files of a directory the test process owns (CRASH_WINDOWS), so what a
// killed hopper did on the host outlives it. Each run appends its step to `runs.jsonl` and leaves the host's scratch
// (`scratch/<host>`) until a sweep removes it. A command that says `hang` runs until it is stopped. A step given vault
// secrets (issue #1957) prints each one in its log, split across two chunks, as a careless step would, and appends to
// `delivered.jsonl` each secret's name and the SHA-256 of its value: what the host got, with no form of the value.
import { createHash } from 'node:crypto';
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
      for (const [name, value] of Object.entries(step.secrets ?? {})) {
        appendFileSync(join(dir, 'delivered.jsonl'), `${JSON.stringify({ step: step.id, name, sha256: sha256(value) })}\n`);
        io.log(`token ${value.slice(0, 5)}`);
        io.log(`${value.slice(5)} used\n`);
      }
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

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** The vault secrets the host was given, in order: each step's secret by name, and the SHA-256 of its value. */
export function deliveredOn(dir: string): { step: string; name: string; sha256: string }[] {
  const file = join(dir, 'delivered.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { step: string; name: string; sha256: string }) : [];
}

/** The steps run on the host, in order: each run is one line. */
export function runsOn(dir: string): string[] {
  const file = join(dir, 'runs.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { step: string }).step) : [];
}

/** Whether the host keeps a scratch directory not swept. */
export const scratchLeft = (dir: string, host: string): boolean => existsSync(join(dir, 'scratch', host));
