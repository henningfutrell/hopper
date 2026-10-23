// Issue #2623: the daemon ran as its container's PID 1, so each orphan of its children (ssh's connection master, git's
// detached gc, an agent CLI's helper) was given to it, and Node, which waits only on the children it starts, left each
// one a zombie. The image runs tini first, a subreaper too, and says how the daemon restarts, as it is no longer PID 1.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(join(import.meta.dirname, '..', '..', 'Dockerfile'), 'utf8');
const daemonStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM '));

describe('the image runs the daemon under an init', () => {
  it('installs tini and runs it first, as a subreaper, with the daemon as its child', () => {
    expect(daemonStage).toMatch(/apt-get install[^\n]* tini /);
    expect(daemonStage).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--"]');
    expect(daemonStage.trimEnd().endsWith('CMD ["node", "src/main.ts"]')).toBe(true);
  });

  it('restarts the daemon after an update by exit, for the container to start it again', () => {
    expect(daemonStage).toMatch(/HOPPER_RESTART=exit/);
  });
});
