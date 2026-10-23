// `hopper job submit --push-requirements <file>` (issue #2555 part 3): the direct job's own push requirements, read from a
// file of the same shape as a repository's `.hopper/requirements.yaml`, before any daemon.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { directCall } from '../../src/cli-operator-direct.ts';

const dir = mkdtempSync(join(tmpdir(), 'hopper-direct-submit-'));
const file = (name: string, text: string): string => { writeFileSync(join(dir, name), text); return join(dir, name); };

describe('hopper job submit --push-requirements (issue #2555 part 3)', () => {
  it('sends the requirements of the file with the submission', async () => {
    const f = file('ok.yaml', 'requirements:\n  - id: lint\n    checks: [{ name: lint, run: npm run lint }]\n');
    const call = directCall('submit', ['--title', 'T', '--brief', 'B', '--push-requirements', f])!;
    expect(await call.body!(async () => undefined)).toMatchObject({ pushRequirements: [{ id: 'lint', checks: [{ name: 'lint', run: 'npm run lint' }] }] });
  });

  it('refuses a file it cannot read, with the file\'s reason, before any call', () => {
    const f = file('bad.yaml', 'requirements:\n  - id: lint\n    checks: []\n');
    expect(() => directCall('submit', ['--title', 'T', '--brief', 'B', '--push-requirements', f])).toThrow(/bad\.yaml: a requirement names at least one check/);
    expect(() => directCall('submit', ['--title', 'T', '--brief', 'B', '--push-requirements', join(dir, 'none.yaml')])).toThrow(/none\.yaml/);
  });
});
