// Issue #708, through the real composition root and the real HTTP server: the line Add machine shows for a sandbox box
// the hopper does not start carries the sandbox flags of the boxes it does start, from the same builder, with the
// CPUs and memory asked for, each within the template's limits.
//
// Feature: the line Add machine shows for a sandbox box
//   Scenario: a box of no template: the hopper's default limits; a computer's line has no flags
//   Scenario: a box of a template: its defaults, or what is asked for within its max
//   Scenario: a value over the template's max is refused with what it allows, and no join code is made
import { afterEach, describe, expect, it } from 'vitest';
import { runFlags } from '../../src/sandbox/flags.ts';
import { DEFAULT_LIMITS } from '../../src/sandbox/params.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { KEY } from '../support/webhooks.ts';

let t: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await t?.stop();
  t = undefined;
  cleanup?.();
});

type Minted = { code?: string; flags?: string; error?: string };

async function boot(): Promise<{ a: TestApp; join: (body: unknown) => Promise<{ status: number; body: Minted }>; session: string }> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  t = await startTestApp({ dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY }, seams: { containerRuntime: createFakeContainerRuntime(), startCheckMs: 1000 } });
  const a = t;
  const session = await a.login();
  return { a, session, join: (body) => a.ui<Minted>('/ui/api/machines/join', body, { token: session }) };
}

describe('the line Add machine shows for a sandbox box', () => {
  it('a box of no template: the hopper\'s default limits; a computer\'s line has no flags', async () => {
    const { a, session, join } = await boot();
    const plain = await join({ box: {} });
    expect(plain.status).toBe(200);
    expect(plain.body.code).toBeTruthy();
    expect(plain.body.flags).toBe(runFlags({ cpus: DEFAULT_LIMITS.cpus.default, memoryMb: DEFAULT_LIMITS.memoryMb.default }).join(' '));
    expect((await join({})).body.flags).toBeUndefined();
    // The flags come with the join code only: the sandboxes view no longer carries a line.
    expect((await a.api('GET', '/api/sandboxes', undefined, { 'x-hopper-session': session })).body).not.toHaveProperty('line');
  });

  it('a box of a template: its defaults, or what is asked for within its max; over the max is refused', async () => {
    const { a, session, join } = await boot();
    const saved = await a.ui('/ui/api/vault', { action: 'save-template', name: 'kube', image: 'example.org/kube-box:1', secrets: [], limits: { cpus: { default: 2, max: 4 }, memoryMb: { default: 2048, max: 4096 } } }, { token: session });
    expect(saved.status).toBe(200);
    expect((await join({ template: 'kube', box: {} })).body.flags).toBe(runFlags({ cpus: 2, memoryMb: 2048 }).join(' '));
    expect((await join({ template: 'kube', box: { cpus: 3 } })).body.flags).toBe(runFlags({ cpus: 3, memoryMb: 2048 }).join(' '));
    const over = await join({ template: 'kube', box: { memoryMb: 8192 } });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain('at most 4096');
    expect(over.body.code).toBeUndefined();
  });
});
