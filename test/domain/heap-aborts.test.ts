// Heap aborts (issue #2722): a Node process in a job that V8 ended because its heap reached its limit (tsc in a job scope,
// issue #2721) wrote a report of its own, which the reap reads; the job records it as a heap abort, with the command, the
// heap limit and the process's peak memory, in place of the bare exit code the agent saw.
import { describe, expect, it } from 'vitest';
import { heapAbortedOf, heapAborts, heapCommandOf, nodeReportEnv } from '../../src/domain/heap-aborts.ts';
import type { DomainEvent } from '../../src/domain/types.ts';

const GIB = 1024 ** 3;

describe("a job's Node processes write a report when their heap runs out", () => {
  it('NODE_OPTIONS asks for a compact report on a fatal error, in the job\'s temp dir', () => {
    expect(nodeReportEnv('/tmp/hopper-j1')).toEqual({ NODE_OPTIONS: '--report-on-fatalerror --report-compact --report-directory=/tmp/hopper-j1' });
  });

  it("keeps the payload's own NODE_OPTIONS after it, so they win", () => {
    expect(nodeReportEnv('/tmp/hopper-j1', { NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS)
      .toBe('--report-on-fatalerror --report-compact --report-directory=/tmp/hopper-j1 --max-old-space-size=4096');
  });
});

describe('the command of a heap abort', () => {
  it('the script node ran, by its name, with its arguments', () => {
    expect(heapCommandOf(['node', '/w/@deps/abc/node_modules/typescript/bin/tsc', '--noEmit', '-p', '.'])).toBe('tsc --noEmit -p .');
  });

  it("node's own options left out, and no path but a file's name", () => {
    expect(heapCommandOf(['/usr/bin/node', '--max-old-space-size=2048', '/w/node_modules/vitest/vitest.mjs', 'run', '/w/test/a.test.ts'])).toBe('vitest.mjs run a.test.ts');
  });

  it('node itself when it ran no script, and a long command cut short', () => {
    expect(heapCommandOf(['node', '-e', 'const a = []; for (;;) a.push(1)'])).toBe('node');
    expect(heapCommandOf(['node', 'build.js', 'x'.repeat(300)]).length).toBeLessThanOrEqual(120);
    expect(heapCommandOf([])).toBe('node');
  });

  it('a program that is not node, by its name', () => {
    expect(heapCommandOf(['/opt/bin/esbuild-wrapper', 'bundle'])).toBe('esbuild-wrapper bundle');
  });
});

describe('a heap abort as the job records it (job.heap_aborted)', () => {
  it('the command, the heap limit, the peak memory and when it aborted', () => {
    expect(heapAbortedOf({ commandLine: ['node', '/x/tsc', '-p', '.'], heapLimitBytes: 2144 * 1024 ** 2, rssPeakBytes: 2.5 * GIB, abortedAtMs: Date.parse('2026-10-24T10:41:00.000Z') }))
      .toEqual({ command: 'tsc -p .', heapLimitBytes: 2144 * 1024 ** 2, rssPeakBytes: 2.5 * GIB, abortedAt: '2026-10-24T10:41:00.000Z' });
    expect(heapAbortedOf({})).toEqual({ command: 'node' });
  });
});

describe("heap aborts in the job's parts list", () => {
  const event = (data: Record<string, unknown>, seq: number, machineId = 'm1'): DomainEvent =>
    ({ seq, type: 'job.heap_aborted', jobId: 'j1', machineId, at: '2026-10-24T11:00:00.000Z', data }) as DomainEvent;

  it('one failed part each under machines: what ran out of heap, its heap limit, its peak and its machine', () => {
    expect(heapAborts([event({ command: 'tsc --noEmit -p .', heapLimitBytes: 2144 * 1024 ** 2, rssPeakBytes: 2.2 * GIB, abortedAt: '2026-10-24T10:41:00.000Z' }, 7)])).toEqual([{
      id: 'heap-abort:7', group: 'machines', kind: 'heap_abort', label: 'tsc ran out of heap', status: 'failed', at: '2026-10-24T10:41:00.000Z',
      detail: 'tsc --noEmit -p .: heap limit 2.1 GiB, peak 2.2 GiB, on m1', href: '#machines',
    }]);
  });

  it('only what the report said', () => {
    expect(heapAborts([event({ command: 'node' }, 3)])).toMatchObject([{ label: 'node ran out of heap', detail: 'node: on m1', at: '2026-10-24T11:00:00.000Z' }]);
    expect(heapAborts([])).toEqual([]);
  });
});
