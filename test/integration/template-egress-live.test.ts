// Issue #2639 part 4, through the real composition root and the real HTTP server: an approved egress host is live in the
// egress proxy before the approval ends. The allowlist grew only when a box started, so a box that ran already (a
// job's sandbox box, a bastion) got 403 for a host a person had just approved.
//
// Feature: an approved egress host is live at once
//   Scenario: the approval waits for the proxy to take the new host
//     Given a hopper whose boxes run behind the egress proxy
//     And the template e2e names the egress host auth.example.test:443, not approved
//     When an admin approves e2e
//     Then the proxy's allowlist holds the host, and the proxy took it, before the approval answers
//   Scenario: an approval with no new egress host does not wait for the proxy
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';
import { KEY } from '../support/webhooks.ts';

const IMAGE = 'ghcr.io/henningfutrell/hopper:box-claude';
const HOST = 'auth.example.test:443';

let t: TestApp | undefined;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await t?.stop();
  t = undefined;
  for (const c of cleanups.splice(0)) c();
});

const read = (dir: string, name: string): string => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return ''; } };

/** The egress proxy as the compose service acts: it takes each new version a moment after the hopper writes it. */
function fakeProxy(dir: string, takes: { ok: boolean }): () => void {
  const timer = setInterval(() => {
    const version = read(dir, 'version').trim();
    if (takes.ok && version && read(dir, 'loaded').trim() !== version) writeFileSync(join(dir, 'loaded'), `${version}\n`);
  }, 50);
  return () => clearInterval(timer);
}

async function boot(): Promise<{ a: TestApp; session: string; dir: string }> {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const dir = join(db.dbPath, '..', 'egress');
  mkdirSync(dir, { recursive: true });
  t = await startTestApp({
    dbPath: db.dbPath, secrets: { HOPPER_MASTER_KEY: KEY },
    env: { HOPPER_SANDBOX_EGRESS_NETWORK: 'hopper_egress', HOPPER_SANDBOX_EGRESS_PROXY: 'http://egress:3128', HOPPER_SANDBOX_EGRESS_DIR: dir },
    seams: { containerRuntime: createFakeContainerRuntime('podman') },
  });
  const session = await t.login();
  return { a: t, session, dir };
}

const edit = (a: TestApp, session: string, body: Record<string, unknown>) => a.ui<{ error?: string }>('/ui/api/vault', body, { token: session });

describe('an approved egress host is live at once (issue #2639 part 4)', () => {
  it('is in the proxy\'s allowlist, and the proxy took it, before the approval answers', async () => {
    const { a, session, dir } = await boot();
    const takes = { ok: true };
    cleanups.push(fakeProxy(dir, takes));
    expect((await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: [], egress: [HOST] })).status).toBe(200);
    expect(read(dir, 'filter')).toBe('');

    expect((await edit(a, session, { action: 'approve-template', name: 'e2e' })).status).toBe(200);
    expect(read(dir, 'filter')).toContain('^auth\\.example\\.test$');
    const version = read(dir, 'version').trim();
    expect(version).not.toBe('');
    expect(read(dir, 'loaded').trim()).toBe(version);
  });

  it('does not wait for the proxy when no egress host is new', async () => {
    const { a, session, dir } = await boot();
    const takes = { ok: true };
    cleanups.push(fakeProxy(dir, takes));
    await edit(a, session, { action: 'save-template', name: 'e2e', image: IMAGE, secrets: [], egress: [HOST] });
    await edit(a, session, { action: 'approve-template', name: 'e2e' });
    // The proxy stops: an approval that adds no host is not held by it.
    takes.ok = false;
    await edit(a, session, { action: 'save-template', name: 'other', image: IMAGE, secrets: [] });
    const started = Date.now();
    expect((await edit(a, session, { action: 'approve-template', name: 'other' })).status).toBe(200);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
