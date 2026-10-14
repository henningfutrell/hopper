// Issue #1108: the hopper's own database runs in a service of its stack. While that database answers, the service runs,
// whatever the compose network's name lookup says: a rootless Podman stack (podman-compose) can fail that lookup for a
// service the hopper is connected to, and the drift check then named postgres as not running while it was healthy.
import { describe, expect, it } from 'vitest';
import { createStackProbe, databaseHostOf } from '../../src/update/stack-probe.ts';

// A name no resolver answers (RFC 6761), so the lookup alone says "not running".
const HOST = 'postgres.invalid';

describe('the stack probe (issues #697, #1108)', () => {
  it('counts the service of the hopper\'s database as running while the database answers, even when its name does not resolve', async () => {
    const probe = createStackProbe({ database: { host: HOST, answers: () => true } });
    expect(await probe.resolves(HOST)).toBe(true);
  });

  it('asks the network for that service when the database does not answer', async () => {
    const probe = createStackProbe({ database: { host: HOST, answers: () => { throw new Error('connection refused'); } } });
    expect(await probe.resolves(HOST)).toBe(false);
  });

  it('asks the network for every other service', async () => {
    let asked = 0;
    const probe = createStackProbe({ database: { host: 'postgres', answers: () => { asked++; return true; } } });
    expect(await probe.resolves('openfga.invalid')).toBe(false);
    expect(asked).toBe(0);
  });
});

describe('the database host of HOPPER_DATABASE_URL (issue #1108)', () => {
  it('is the URL\'s host, and none when the URL names none', () => {
    const answers = () => true;
    expect(databaseHostOf('postgres://hopper:pw@postgres:5432/hopper', answers)).toEqual({ host: 'postgres', answers });
    expect(databaseHostOf('not a url', answers)).toBeUndefined();
  });
});
