// gh login from the UI (issue #138): the hopper runs gh's device flow without a terminal, the UI
// shows its device code, and the gh CLI ends up logged in — in a container, no `exec -it` and no
// token in .env. gh is a stand-in on PATH (the CLI is the seam); the daemon and HTTP edge are real.
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GhLoginStatus } from '../../src/domain/types.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) c();
});

// gh as it prints on its non-interactive path (stderr), waiting for the user to approve or deny the code.
// `approve` / `deny` in its dir stand in for the user at github.com/login/device.
const FAKE_GH = `#!/bin/sh
dir=$(dirname "$0")
case "$1 $2" in
  "auth status")
    if [ -f "$dir/logged-in" ]; then echo "github.com" >&2; echo "  ✓ Logged in to github.com account octo-user (keyring)" >&2; exit 0; fi
    echo "You are not logged into any GitHub hosts. To log in, run: gh auth login" >&2; exit 1 ;;
  "auth login")
    echo "$*" >> "$dir/login-args"
    echo "! First copy your one-time code: ABCD-1234" >&2
    echo "Open this URL to continue in your web browser: https://github.com/login/device" >&2
    while :; do
      if [ -f "$dir/approve" ]; then touch "$dir/logged-in"; echo "✓ Logged in as octo-user" >&2; exit 0; fi
      if [ -f "$dir/deny" ]; then echo "error: the device code was denied" >&2; exit 1; fi
      sleep 0.05
    done ;;
esac
exit 2
`;

function fakeGh() {
  const dir = mkdtempSync(join(tmpdir(), 'jh-fake-gh-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'gh'), FAKE_GH);
  chmodSync(join(dir, 'gh'), 0o755);
  return { dir, path: `${dir}:${process.env.PATH ?? ''}`, user: (what: 'approve' | 'deny') => writeFileSync(join(dir, what), '') };
}

async function start(secrets: Record<string, string | undefined>) {
  const db = tempDbPath();
  cleanups.push(db.cleanup);
  const app = await startTestApp({ dbPath: db.dbPath, secrets });
  apps.push(app);
  return app;
}

const status = async (app: TestApp) => (await app.api<GhLoginStatus>('GET', '/api/gh-login')).body;

describe('gh login from the UI', () => {
  it('shows the device code, and gh is logged in once the user approves it', async () => {
    const gh = fakeGh();
    const app = await start({ PATH: gh.path });
    expect(await status(app)).toEqual({ state: 'logged-out' });
    expect((await app.ui('/ui/api/gh-login', { action: 'start' })).status).toBe(403);

    const token = await app.login();
    const [started, twice] = await Promise.all([1, 2].map(() => app.ui<GhLoginStatus>('/ui/api/gh-login', { action: 'start' }, { token })));
    expect(twice.body).toEqual(started.body);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ state: 'waiting', userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' });
    // No terminal: gh's web flow, HTTPS for git, github.com — nothing for gh to ask.
    expect(readFileSync(join(gh.dir, 'login-args'), 'utf8').trim()).toBe('auth login --web --hostname github.com --git-protocol https');
    // A second start while one waits answers the same code: one flow at a time.
    expect((await app.ui<GhLoginStatus>('/ui/api/gh-login', { action: 'start' }, { token })).body).toMatchObject({ userCode: 'ABCD-1234' });
    expect(await status(app)).toMatchObject({ state: 'waiting', userCode: 'ABCD-1234' });

    gh.user('approve');
    await waitFor(async () => (await status(app)).state === 'logged-in');
    expect(await status(app)).toEqual({ state: 'logged-in', account: 'octo-user' });
  });

  it('reports a denied code, and a new start begins again', async () => {
    const gh = fakeGh();
    const app = await start({ PATH: gh.path });
    const token = await app.login();
    await app.ui('/ui/api/gh-login', { action: 'start' }, { token });
    gh.user('deny');
    await waitFor(async () => (await status(app)).state === 'failed');
    expect(await status(app)).toEqual({ state: 'failed', error: 'error: the device code was denied' });
    rmSync(join(gh.dir, 'deny'));
    expect((await app.ui<GhLoginStatus>('/ui/api/gh-login', { action: 'start' }, { token })).body.state).toBe('waiting');
  });

  it('cancels a waiting login', async () => {
    const gh = fakeGh();
    const app = await start({ PATH: gh.path });
    const token = await app.login();
    await app.ui('/ui/api/gh-login', { action: 'start' }, { token });
    expect((await app.ui<GhLoginStatus>('/ui/api/gh-login', { action: 'cancel' }, { token })).body).toEqual({ state: 'logged-out' });
    gh.user('approve');
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(gh.dir, 'logged-in'))).toBe(false);
  });

  it('says why when GH_TOKEN is set: gh logs in from the variable, not from a stored login', async () => {
    const gh = fakeGh();
    const app = await start({ PATH: gh.path, GH_TOKEN: 'not-a-token' });
    const token = await app.login();
    const r = await app.ui<GhLoginStatus>('/ui/api/gh-login', { action: 'start' }, { token });
    expect(r.body).toEqual({ state: 'failed', error: "GH_TOKEN is set and gh uses it instead of a login: remove it from the hopper's environment (.env) and restart, then log in" });
    expect(existsSync(join(gh.dir, 'login-args'))).toBe(false);
  });

  it('is unavailable without gh', async () => {
    const app = await start({ PATH: mkdtempSync(join(tmpdir(), 'jh-no-gh-')) });
    expect(await status(app)).toEqual({ state: 'unavailable', reason: 'gh not found: gh' });
    const token = await app.login();
    expect((await app.ui('/ui/api/gh-login', { action: 'start' }, { token })).status).toBe(409);
  });
});
