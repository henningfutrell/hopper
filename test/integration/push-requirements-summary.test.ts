// The push requirements summary on the pull request (issue #2555 part 4, design.md "Push requirements"): the job's
// evaluation of the commit it pushed, in a section of its pull request's body that the hopper keeps.
//
// Feature: the evaluation summarized on the pull request
//   Scenario: a job evaluates, pushes and opens its pull request, then pushes a fix
//     Then the pull request it opens holds the summary of its pushed commit: each requirement's status, command,
//       thresholds and measured values, with its own text first and the post key line last
//     And after its next evaluated push the hopper replaces the summary with that commit's, and records it
//     And a pull request the job did not open is not changed
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { eventsOf, start, stopGitProxies } from '../support/git-proxy.ts';
import { hopperGh } from '../support/job-holder.ts';
import { jobOnBranch } from '../support/push-requirements.ts';
import { waitFor } from '../support/wait.ts';

afterEach(stopGitProxies);

describe('the push requirements summary on the pull request (issue #2555 part 4)', () => {
  it('is in the pull request the job opens, and the hopper replaces it after each evaluated push', async () => {
    const t = await start();
    t.pulls.push({ repo: 'octo/tools', number: 50, title: 'A person\'s change', body: 'A person\'s text.', head: 'issue-8', base: 'dev' });
    const r = await jobOnBranch(t);
    const commit = async (measured: number) => {
      writeFileSync(join(r.work, 'coverage.txt'), `hopper-measure changedLines=${measured}\n`);
      await r.git(['commit', '--quiet', '-am', `Cover B to ${measured}`], r.work);
      expect(await r.requirements('check')).toMatchObject({ code: 0 });
      expect(await r.push()).toMatchObject({ code: 0 });
      return (await r.git(['rev-parse', 'HEAD'], r.work)).stdout.trim();
    };
    const first = await commit(84);

    const pr = await hopperGh(t.root, r.env, ['pr', 'create', '--repo', 'octo/tools', '--head', 'issue-7', '--title', 'Add B', '--body', 'Closes #7']);
    expect(pr.code).toBe(0);
    const pull = t.pulls.find((p) => p.head === 'issue-7')!;
    expect(pull.body.startsWith('Closes #7\n\n<!-- hopper push requirements -->')).toBe(true);
    expect(pull.body).toContain(`Passed for \`${first.slice(0, 12)}\` against \`dev\``);
    expect(pull.body).toContain('| `kotlin-coverage` | repo | passed | changed-files coverage | `cat coverage.txt` | changedLines ≥ 80 | changedLines 84 |');
    expect(pull.body).toContain('| `migrations` | repo | skipped: no changed files match `**/*.sql`; and no changed files match `**/migrations/**` | | | | |');
    expect(pull.body.trimEnd().split('\n').at(-1)).toMatch(/^<!-- hopper post /);

    // Pushed to a branch whose pull request a person opened: the hopper leaves it alone.
    expect(await r.git(['push', 'origin', 'HEAD:refs/heads/issue-8'], r.work)).toMatchObject({ code: 0 });
    const second = await commit(91);
    await waitFor(() => pull.body.includes(second.slice(0, 12)) || undefined, { what: 'the summary of the second push' });
    expect(pull.body).toContain('| changedLines 91 |');
    expect(pull.body).not.toContain(first.slice(0, 12));
    expect(pull.body.startsWith('Closes #7\n\n')).toBe(true);
    expect(pull.body.match(/<!-- hopper push requirements -->/g)).toHaveLength(1);
    expect(eventsOf(t.app, 'push_requirements.summarized').map((e) => e.data)).toEqual([{ repo: 'octo/tools', number: pull.number, head: second }]);
    expect(t.pulls.find((p) => p.number === 50)!.body).toBe('A person\'s text.');
    t.held.get(r.job.id)!.end();
    await t.app.waitForStatus(r.job.id, 'finished');
  }, 90_000);
});
