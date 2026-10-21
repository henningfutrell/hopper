// Issue #2302, part 4: waste signals. A job that spends tokens with no progress is flagged — many turns with no commit or
// push, repeated failing local test runs, a resume loop, cache-write churn —, and tokens per merged pull request is the
// efficiency number. The failed test runs are counted from the agent session's log; only the count is kept. Pure.
import { describe, expect, it } from 'vitest';
import { sessionTokenUse, sumTokenUse, type ModelTokenUse } from '../../src/domain/token-usage.ts';
import { perMergedPullRequest, tokenWaste, WASTE } from '../../src/domain/token-waste.ts';

const line = (o: object): string => JSON.stringify(o);
let n = 0;
/** An assistant message that runs one shell command, and the tool result that answers it. */
const run = (command: string, failed: boolean, model = 'claude-opus-5-5'): string[] => {
  n += 1;
  return [
    line({ type: 'assistant', requestId: `r${n}`, message: { id: `m${n}`, model, content: [{ type: 'tool_use', id: `toolu_${n}`, name: 'Bash', input: { command } }], usage: { input_tokens: 1, output_tokens: 1 } } }),
    line({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, ...(failed ? { is_error: true } : {}), content: 'FAIL secret output text' }] } }),
  ];
};

describe('failed test runs in an agent session (issue #2302, part 4)', () => {
  it('counts each test run whose tool result is an error, on the model that ran it', () => {
    const log = [
      ...run('npx vitest run test/a.test.ts', true), ...run('npm test', true), ...run('npx vitest run test/a.test.ts', false),
      ...run('npm run typecheck', true), ...run('pytest -q', true, 'claude-haiku-4-5'), ...run('ls', true),
    ].join('\n');
    const use = sessionTokenUse(log);
    expect(use.models.map((m) => [m.model, m.turns, m.failedTests])).toEqual([['claude-haiku-4-5', 1, 1], ['claude-opus-5-5', 5, 2]]);
    expect(sumTokenUse(use.models).failedTests).toBe(3);
    expect(JSON.stringify(use)).not.toContain('secret output text');
    expect(JSON.stringify(use)).not.toContain('vitest');
  });

  it('has no failed test runs when none failed', () => {
    const use = sessionTokenUse(run('npx vitest run', false).join('\n'));
    expect(use.models[0]).not.toHaveProperty('failedTests');
    expect(sumTokenUse(use.models)).not.toHaveProperty('failedTests');
  });
});

describe('waste signals (issue #2302, part 4)', () => {
  const use = (o: Partial<ModelTokenUse>): ReturnType<typeof sumTokenUse> => sumTokenUse([{ model: 'claude-opus-5-5', turns: 10, input: 100, output: 100, cacheRead: 10_000_000, cacheWrite: 100_000, ...o }]);
  const progress = { pushes: 1, commits: 1, attempts: 1 };

  it('flags nothing for a job that pushed its work in few turns', () => {
    expect(tokenWaste(use({}), progress)).toEqual([]);
  });

  it('flags many turns with no commit and no push', () => {
    expect(tokenWaste(use({ turns: WASTE.noProgressTurns }), { pushes: 0, commits: 0, attempts: 1 }).map((w) => w.kind)).toEqual(['no_progress']);
    // A commit not pushed yet is progress.
    expect(tokenWaste(use({ turns: WASTE.noProgressTurns }), { pushes: 0, commits: 2, attempts: 1 })).toEqual([]);
    expect(tokenWaste(use({ turns: WASTE.noProgressTurns - 1 }), { pushes: 0, commits: 0, attempts: 1 })).toEqual([]);
  });

  it('flags repeated failing test runs', () => {
    const [w] = tokenWaste(use({ failedTests: WASTE.failingTests }), progress);
    expect(w).toMatchObject({ kind: 'failing_tests' });
    expect(w!.why).toContain(`${WASTE.failingTests} test runs failed`);
    expect(tokenWaste(use({ failedTests: WASTE.failingTests - 1 }), progress)).toEqual([]);
  });

  it('flags a resume loop', () => {
    expect(tokenWaste(use({}), { ...progress, attempts: WASTE.resumeLoopAttempts }).map((w) => w.kind)).toEqual(['resume_loop']);
    expect(tokenWaste(use({}), { ...progress, attempts: WASTE.resumeLoopAttempts - 1 })).toEqual([]);
  });

  it('flags cache-write churn: much written to the cache, little read back', () => {
    expect(tokenWaste(use({ cacheRead: 3_000_000, cacheWrite: 3_000_000 }), progress).map((w) => w.kind)).toEqual(['cache_churn']);
    // A small job is not flagged, whatever its share.
    expect(tokenWaste(use({ cacheRead: 0, cacheWrite: WASTE.churnTokens - 1 }), progress)).toEqual([]);
    // Much written but read back many times over is a cache at work.
    expect(tokenWaste(use({ cacheRead: 40_000_000, cacheWrite: 3_000_000 }), progress)).toEqual([]);
  });

  it('gives each signal in a fixed order', () => {
    const all = tokenWaste(use({ turns: 500, failedTests: 9, cacheRead: 0, cacheWrite: 5_000_000 }), { pushes: 0, commits: 0, attempts: 9 });
    expect(all.map((w) => w.kind)).toEqual(['no_progress', 'failing_tests', 'resume_loop', 'cache_churn']);
  });
});

describe('tokens per merged pull request (issue #2302, part 4)', () => {
  it('divides every token and the cost by the pull requests merged', () => {
    const total = sumTokenUse([{ model: 'claude-opus-5-5', turns: 4, input: 1000, output: 1000, cacheRead: 1000, cacheWrite: 1000 }]);
    expect(perMergedPullRequest(total, 4)).toEqual({ pullRequests: 4, tokens: 1000, costUsd: total.costUsd / 4 });
  });

  it('has no number when no pull request was merged', () => {
    expect(perMergedPullRequest(sumTokenUse([]), 0)).toEqual({ pullRequests: 0 });
  });
});
