// Issue #141: a hopper that is not a machine (the container: HOPPER_LOCAL_MACHINE=false) registers no
// `local` machine. plugins.yaml without a `machines:` section means the built-in instances, and for it
// those are none. Real HTTP server, plugins.yaml in the database.
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

async function machineIds(env: Record<string, string>): Promise<string[]> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, env });
  return ((await t.api('GET', '/api/machines')).body.machines as { id: string }[]).map((m) => m.id);
}

describe('the hopper as a machine (issue #141)', () => {
  it('HOPPER_LOCAL_MACHINE=false: no `local` machine where plugins.yaml names no machines', async () => {
    expect(await machineIds({ HOPPER_LOCAL_MACHINE: 'false' })).toEqual([]);
  });

  it('by default the hopper\'s own host is the `local` machine', async () => {
    expect(await machineIds({})).toEqual(['local']);
  });
});
