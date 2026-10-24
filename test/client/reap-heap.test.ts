// Heap aborts (issue #2722): a Node process of the job that runs out of heap writes its report to the job's temp dir (its
// scratch dir), as NODE_OPTIONS asks; the reap says each such report, then removes it, so a later reap of kept work does
// not say it again. Run for real: a node with a tiny heap runs out of it.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readReap, reapArgv } from '../../src/client/reap.ts';
import { nodeReportEnv } from '../../src/domain/heap-aborts.ts';

const JOB = 'job-2722-abcdef';

let root: string;
let scratch: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reap-heap-'));
  scratch = join(root, 'w', '.worktrees', '@scratch', JOB);
  mkdirSync(scratch, { recursive: true });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const reap = (): string => {
  const [file, ...args] = reapArgv(JOB, scratch, true);
  return execFileSync(file!, args, { encoding: 'utf8', timeout: 30000 });
};

describe('the reap says the heap aborts of the job (issue #2722)', () => {
  it("a node that ran out of heap: its command line, heap limit, peak memory and time; the report is gone after", () => {
    const run = spawnSync(process.execPath, ['--max-old-space-size=16', '-e', 'const a = []; for (;;) a.push(new Array(1e5).fill(1))'], {
      cwd: scratch, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...nodeReportEnv(scratch) },
    });
    expect(run.status).not.toBe(0);
    const heap = readReap(reap())?.heap;
    expect(heap).toHaveLength(1);
    expect(heap![0]!.commandLine?.slice(0, 2)).toEqual([process.execPath, '--max-old-space-size=16']);
    expect(heap![0]!.heapLimitBytes).toBeGreaterThan(16 * 1024 ** 2);
    expect(heap![0]!.rssPeakBytes).toBeGreaterThan(16 * 1024 ** 2);
    expect(Math.abs(heap![0]!.abortedAtMs! - Date.now())).toBeLessThan(60000);
    expect(readdirSync(scratch).filter((f) => f.startsWith('report.'))).toEqual([]);
  });

  it('only reports of a heap that ran out, and none at all when there are none', () => {
    writeFileSync(join(scratch, 'report.20261024.1.1.0.001.json'), '{"header":{"event":"JavaScript API","trigger":"API","commandLine":["node","x.js"]}}');
    expect(readReap(reap())?.heap).toBeUndefined();
  });

  it('a report it cannot read whole still says that the heap ran out', () => {
    writeFileSync(join(scratch, 'report.20261024.1.2.0.001.json'), '{"header":{"event":"Allocation failed - JavaScript heap out of memory","trigger":"OOMError","commandLine":["node","a]b"]');
    expect(readReap(reap())?.heap).toEqual([{}]);
  });
});
