// Issue #1038: a test that runs a `#!/usr/bin/env node` double with a bare system PATH finds the test run's own node,
// on a machine whose node is not in /usr/bin, and nothing else of node's own dir.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { systemPath } from './system-path.ts';

describe('systemPath', () => {
  it('puts the given dirs first, then /usr/bin and /bin', () => {
    expect(systemPath('/a', '/b').split(delimiter).slice(0, 4)).toEqual(['/a', '/b', '/usr/bin', '/bin']);
  });

  it('finds the test run\'s node for a `#!/usr/bin/env node` script', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jh-sp-'));
    const script = join(dir, 'double');
    writeFileSync(script, '#!/usr/bin/env node\nprocess.stdout.write(process.version);\n');
    chmodSync(script, 0o755);
    expect(execFileSync(script, { env: { PATH: systemPath() }, encoding: 'utf8' })).toBe(process.version);
  });

  it('holds no dir of node\'s own but a dir with node alone', () => {
    expect(systemPath().split(delimiter)).not.toContain(dirname(process.execPath));
  });
});
