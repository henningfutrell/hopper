// The push requirements' event doc and example (issue #2555): part of EVENT_DOCS (docs.ts) and the examples (examples.ts),
// apart for their size.
export const PUSH_REQUIREMENT_EVENT_DOCS: Record<'push_requirements.evaluated' | 'push_requirements.defaults_changed' | 'push_requirements.summarized' | 'push_requirements.ci_missed', string> = {
  'push_requirements.evaluated': 'A running job evaluated the push requirements of a commit in its work tree (issue #2555), with `sh "$HOPPER_REQUIREMENTS" check`: `repo`, `branch`, its `base` and the commit, `head`. `requirements`: each requirement that applied (`passed` or `failed`, each check with its command `run`, its `exit`, its `thresholds` and the values it `measured`, and a failed one\'s `problem`) and each one it skipped, with the `reason`; `level`: where it came from (`default`, `repo`, `path`, `job`). `passed`: every requirement that applied passed. The git proxy takes a push of that commit only after a passing one, where requirements apply. Never a check\'s output.',
  'push_requirements.defaults_changed': 'An admin changed the hopper\'s default push requirements (issue #2555), on Settings → Push requirements: the requirements that apply to every repository\'s push, below its own file\'s. `from` and `to`: the ids of the requirements before and after; `by`, who. They apply to the next evaluation and the next push.',
  'push_requirements.summarized': 'After a job\'s push (issue #2555 part 4), the hopper replaced the push requirements summary in the body of the pushed branch\'s open pull request `number` of `repo` with its evaluation of the commit pushed, `head`: each requirement\'s status, each check\'s command, thresholds and measured values, between two hidden lines. Only a pull request the job may edit; the rest of the body stays as it was. A job\'s own `pr create` holds the summary already.',
  'push_requirements.ci_missed': 'A CI run of the job\'s pull request `pullRequest` of `repo` failed on a check that a requirement that applied to its head commit `head` stands for (issue #2555 part 5): the job\'s evaluation of `head` should have caught it. `checks`: the CI checks that failed and that a check\'s `ci.checks` names; `requirements`: those requirements\' ids; `minutes`: the most billed minutes any of their checks names for such a CI run, absent when none names any. Recorded once for each pull request and head commit. Counted by `GET /api/push-requirements/metrics`.',
};

export const PUSH_REQUIREMENT_EVENT_EXAMPLES = {
  'push_requirements.evaluated': {
    repo: 'octo/identity', branch: 'issue-440', base: 'dev', head: '4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b', passed: false,
    requirements: [
      { id: 'kotlin-coverage', level: 'repo', status: 'failed', checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', exit: 0, thresholds: { changedLines: { min: 80 } }, measured: { changedLines: 76 }, ci: { checks: ['coverage*'], minutes: 47 }, passed: false, problem: 'changedLines 76 is under its minimum 80' }] },
      { id: 'migrations', level: 'repo', status: 'skipped', reason: 'no changed files match `**/*.sql`' },
    ],
  },
  'push_requirements.defaults_changed': { from: [], to: ['workflows'], by: 'owner' },
  'push_requirements.summarized': { repo: 'octo/identity', number: 41, head: '4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b' },
  'push_requirements.ci_missed': {
    repo: 'octo/identity', pullRequest: 'https://github.com/octo/identity/pull/41', head: '4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b',
    checks: ['coverage (changed files)'], requirements: ['kotlin-coverage'], minutes: 47,
  },
};
