// The PATH a test gives when it wants this machine's bare system tools only: /usr/bin and /bin, then a dir that holds
// the node that runs the tests and nothing else. On a machine whose node is not in /usr/bin, the `#!/usr/bin/env node`
// test doubles (the ssh stand-in) failed with a bare '/usr/bin:/bin' (issue #1038). Only node: the rest of node's own
// dir (a global `claude`, a `herdr`) stays out, as before.
import { mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

let nodeDir: string | undefined;

/** `first`, then /usr/bin, /bin and the test run's own node. */
export function systemPath(...first: string[]): string {
  if (nodeDir === undefined) {
    nodeDir = mkdtempSync(join(tmpdir(), 'jh-node-'));
    symlinkSync(process.execPath, join(nodeDir, 'node'));
  }
  return [...first, '/usr/bin', '/bin', nodeDir].join(delimiter);
}
