// Head branch deletion under the crash harness (issue #2914): a hopper killed with SIGKILL before its delete call, after GitHub
// took it, or before the row is sent, leaves the row to a second hopper on the same database, and no branch is left.
import { afterEach, describe, expect, it } from 'vitest';
import { outboxKillPoint } from '../../src/sources/github/outbox.ts';
import { createFakeGitHubServer, type FakeGitHubServer } from '../../src/sources/github/http/index.ts';
import { tempDbPath } from '../support/app.ts';
import { databaseUrlFor, ownerSchemaUrlFor } from '../support/database.ts';
import { TEST_ACCOUNT_TOKEN } from '../support/github-account.ts';
import { waitFor } from '../support/wait.ts';
import { killedAt, startHost, stopHosts } from './harness.ts';
import { endClaims, keepRows, openRows } from './outbox-world.ts';

const REPO = 'owner/hopper-sandbox';
const PR = `https://github.com/${REPO}/pull/9`;
const BRANCH = 'hopper/9-fix';
const SCENARIO_MS = 120_000;

let github: FakeGitHubServer | undefined;
let cleanup: (() => void) | undefined;
afterEach(async () => { await stopHosts(); await github?.close(); cleanup?.(); });

const POINTS = [outboxKillPoint('delete_head_branch', 'before-send'), 'head_branch:after-delete', outboxKillPoint('delete_head_branch', 'after-send')];

describe('head branch deletion killed at each step (issue #2914)', () => {
  for (const point of POINTS) {
    it(`killed at ${point}: the next hopper ends it with no branch and no row left`, async () => {
      github = await createFakeGitHubServer({
        login: 'owner', token: TEST_ACCOUNT_TOKEN,
        installations: [{ id: 7, account: 'owner', repos: [{
          owner: 'owner', name: 'hopper-sandbox', labels: ['hopper'], branches: [{ name: BRANCH, sha: 'a1' }],
          issues: [{ number: 9, pullRequest: true, state: 'closed', pull: { headRef: BRANCH, headOid: 'a1', base: 'main', state: 'MERGED' } }],
        }] }],
      });
      const db = tempDbPath();
      cleanup = db.cleanup;
      const databaseUrl = databaseUrlFor(db.dbPath), fakes = { github: github.url };
      const a = await startHost({ dbPath: db.dbPath, databaseUrl, fakes, connectGitHub: [REPO], killPoint: point });
      const w = { userUrl: ownerSchemaUrlFor(db.dbPath) };
      keepRows(w, [{ key: PR, act: 'head_branch', tag: '', change: { op: 'delete_head_branch', pullRequest: PR, via: 'merge' } }]);
      await killedAt(a, point);
      endClaims(w);
      await startHost({ dbPath: db.dbPath, databaseUrl, fakes });
      await waitFor(() => (openRows(w).length === 0 ? true : undefined), { timeoutMs: 60_000, what: 'no row left' });
      expect(github.state.repos.get(REPO)!.branches.size).toBe(0);
    }, SCENARIO_MS);
  }
});
