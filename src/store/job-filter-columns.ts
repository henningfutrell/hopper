// The fields a job or failure list filters on, as generated columns (issue #1154). Each filter on a field of the JSON
// body made Postgres cast every row's body to JSON (about 20 KB a job) on every list, while the event loop waited for
// the answer. Postgres computes a generated column at each write of its row, whoever writes it: the build before, which
// names only `status` and `body`, keeps them right too.
const GENERATED = (expr: string) => `GENERATED ALWAYS AS (${expr}) STORED`;

export const JOB_FILTER_COLUMNS = `
  ALTER TABLE jobs
    ADD COLUMN follow TEXT ${GENERATED("body::jsonb->'sourceState'->'source'->>'follow'")},
    ADD COLUMN pull_request TEXT ${GENERATED("body::jsonb->'sourceState'->'source'->>'pullRequest'")},
    ADD COLUMN assessed BOOLEAN ${GENERATED("body::jsonb->'assessment' IS NOT NULL")},
    ADD COLUMN dismissed BOOLEAN ${GENERATED("body::jsonb->'dismissedAt' IS NOT NULL")};
  ALTER TABLE failures
    ADD COLUMN problem_id TEXT ${GENERATED("body::jsonb->>'problemId'")},
    ADD COLUMN outcome TEXT ${GENERATED("body::jsonb->>'outcome'")};
  CREATE INDEX failures_problem_id ON failures (problem_id)`;
