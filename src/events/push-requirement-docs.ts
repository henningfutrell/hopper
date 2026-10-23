// The push requirements' event doc and example (issue #2555): part of EVENT_DOCS (docs.ts) and the examples (examples.ts),
// apart for their size.
export const PUSH_REQUIREMENT_EVENT_DOCS: Record<'push_requirements.evaluated' | 'push_requirements.defaults_changed', string> = {
  'push_requirements.evaluated': 'A running job evaluated the push requirements of a commit in its work tree (issue #2555), with `sh "$HOPPER_REQUIREMENTS" check`: `repo`, `branch`, its `base` and the commit, `head`. `requirements`: each requirement that applied (`passed` or `failed`, each check with its command `run`, its `exit`, its `thresholds` and the values it `measured`, and a failed one\'s `problem`) and each one it skipped, with the `reason`; `level`: where it came from (`default`, `repo`, `path`, `job`). `passed`: every requirement that applied passed. The git proxy takes a push of that commit only after a passing one, where requirements apply. Never a check\'s output.',
  'push_requirements.defaults_changed': 'An admin changed the hopper\'s default push requirements (issue #2555), on Settings → Push requirements: the requirements that apply to every repository\'s push, below its own file\'s. `from` and `to`: the ids of the requirements before and after; `by`, who. They apply to the next evaluation and the next push.',
};

export const PUSH_REQUIREMENT_EVENT_EXAMPLES = {
  'push_requirements.evaluated': {
    repo: 'octo/identity', branch: 'issue-440', base: 'dev', head: '4f1c2a9e8b7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b', passed: false,
    requirements: [
      { id: 'kotlin-coverage', level: 'repo', status: 'failed', checks: [{ name: 'changed-files coverage', run: './gradlew koverVerify', exit: 0, thresholds: { changedLines: { min: 80 } }, measured: { changedLines: 76 }, passed: false, problem: 'changedLines 76 is under its minimum 80' }] },
      { id: 'migrations', level: 'repo', status: 'skipped', reason: 'no changed files match `**/*.sql`' },
    ],
  },
  'push_requirements.defaults_changed': { from: [], to: ['workflows'], by: 'owner' },
};
