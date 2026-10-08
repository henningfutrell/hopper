// vitest globalSetup, first: a test run leaves nothing behind (issue #401, design.md "Database").
// - One run root, `jh-run-<pid>-*` in the tmpdir, becomes TMPDIR: every worker (forked after this
//   setup, inheriting its env) and every process a test starts makes its temp dirs inside it.
// - HOPPER_TEST_RUN marks every process of the run, so teardown can find the ones a test left running.
// - Teardown, on a pass or a failure: kill the marked processes, remove this run's containers, remove
//   the run root. Setup and teardown both sweep what a dead run left: its run root and its containers
//   (test/support/sweep.ts). A crashed run's leftovers go at the next run's start.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerCli, killMarked, RUN_MARKER, sweepContainers, sweepRunRoots } from './sweep.ts';

export default function setup(): () => Promise<void> {
  const base = tmpdir();
  sweepRunRoots(base);
  sweepContainers(dockerCli);
  const root = mkdtempSync(join(base, `jh-run-${process.pid}-`));
  const marker = randomUUID();
  process.env.TMPDIR = root;
  process.env[RUN_MARKER] = marker;
  return async () => {
    await killMarked(marker);
    sweepContainers(dockerCli);
    rmSync(root, { recursive: true, force: true });
    sweepRunRoots(base);
  };
}
