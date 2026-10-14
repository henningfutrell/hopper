// Landing batches (issue #1073) over the real HTTP server and database: none by default; an admin names a repository's
// tested branch, with the defaults for when a batch run starts, changes one part, and takes it away with null; each
// change is recorded with who, a save that changes nothing records nothing, and a change needs an admin's UI session.
// Fake GitHub at the GitHubApi seam: the runner's own calls find no GitHub here, and the view says so.
import { afterEach, describe, expect, it } from 'vitest';
import { createFakeGitHub } from '../../src/sources/index.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { connectGitHub } from '../support/github-account.ts';

const REPO = 'owner/hopper-sandbox';
let a: TestApp | undefined;
let cleanup: (() => void) | undefined;

afterEach(async () => {
  await a?.stop();
  a = undefined;
  cleanup?.();
});

async function boot(): Promise<TestApp> {
  const db = tempDbPath();
  cleanup = db.cleanup;
  const plugins = { jobSources: [{ name: 'github', plugin: 'github-account', options: { enabled: true, pollSeconds: 3600, executor: 'scripted' } }] };
  a = await startTestApp({ dbPath: db.dbPath, env: {}, seams: { github: createFakeGitHub() }, plugins });
  connectGitHub(a, [REPO]);
  return a;
}

describe('landing batches', () => {
  it('none by default: GET says so and lists the job repositories', async () => {
    const app = await boot();
    expect((await app.api('GET', '/api/landing-batches')).body).toEqual({ settings: { repos: {} }, choices: { repos: [REPO] }, repos: [] });
  });

  it('an admin adds a repository, changes a part, and takes it away; each change is recorded with who', async () => {
    const app = await boot();
    const token = await app.login();
    const added = await app.ui('/ui/api/landing-batches', { repos: { 'Owner/Hopper-Sandbox': { tested: 'dev' } } }, { token });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ settings: { repos: { [REPO]: { tested: 'dev', everyMerges: 5, everyMinutes: 60 } } }, repos: [{ repo: REPO, config: { tested: 'dev' } }] });
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: { everyMerges: 3 } } }, { token })).body)
      .toMatchObject({ settings: { repos: { [REPO]: { tested: 'dev', everyMerges: 3, everyMinutes: 60 } } } });
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: { everyMerges: 3 } } }, { token })).status).toBe(200);
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: null } }, { token })).body).toMatchObject({ settings: { repos: {} }, repos: [] });
    const changed = await app.events('types=landing_batches.changed');
    expect(changed).toHaveLength(3);
    expect(typeof changed[0]!.data.by).toBe('string');
  });

  it('refused without a UI session, or with a body that is no change', async () => {
    const app = await boot();
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: { tested: 'dev' } } })).status).toBe(403);
    const token = await app.login();
    expect((await app.ui('/ui/api/landing-batches', { repos: { [REPO]: { everyMerges: 0 } } }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/landing-batches', { repos: { 'no-repo': { tested: 'dev' } } }, { token })).status).toBe(400);
    expect((await app.ui('/ui/api/landing-batches', { on: true }, { token })).status).toBe(400);
  });
});
