// Tenant migration 32 (issue #613, design.md "The job stream"): each job's stream events, in order, and the watches
// its requests are waited on by, so a restart loses neither. Tables only: the build before runs on them.
export const JOB_STREAM_TABLES = `
  CREATE TABLE job_stream (
    seq BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL,
    request TEXT,
    type TEXT NOT NULL,
    phase TEXT NOT NULL,
    at TEXT NOT NULL,
    payload TEXT NOT NULL
  );
  CREATE INDEX job_stream_job ON job_stream (job_id, seq);
  CREATE TABLE watches (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    deadline TEXT NOT NULL,
    opened_at TEXT NOT NULL,
    body TEXT NOT NULL,
    ended TEXT
  );
  CREATE INDEX watches_open ON watches (deadline) WHERE ended IS NULL`;
