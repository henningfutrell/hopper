// Tenant migration 34 (issue #624, design.md "Artifacts"): the artifacts jobs make for a person to see, their content
// in the database, and their shares. Tables only: the build before runs on them.
export const ARTIFACT_TABLES = `
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    issue_url TEXT,
    issue_ref TEXT,
    title TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    content BYTEA NOT NULL
  );
  CREATE INDEX artifacts_job ON artifacts (job_id, created_at);
  CREATE INDEX artifacts_created ON artifacts (created_at);
  CREATE TABLE artifact_shares (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    user_id TEXT,
    user_name TEXT,
    token_hash TEXT UNIQUE,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    revoked_at TEXT,
    revoked_by TEXT
  );
  CREATE INDEX artifact_shares_artifact ON artifact_shares (artifact_id)`;

// Tenant migration 36 (issue #675, design.md "Artifacts: revisions"): every change to an artifact is a revision. The
// `artifacts` row stays the latest revision, its content included, so the build before reads and serves the latest as
// it did; it fills none of the new columns, and their defaults make what it puts revision 1. The older revisions are
// rows of `artifact_revisions`, removed with their artifact.
export const ARTIFACT_REVISION_TABLES = `
  ALTER TABLE artifacts ADD COLUMN summary TEXT;
  ALTER TABLE artifacts ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE artifacts ADD COLUMN updated_at TEXT;
  ALTER TABLE artifacts ADD COLUMN revised_by TEXT;
  ALTER TABLE artifacts ADD COLUMN note TEXT;
  ALTER TABLE artifacts ADD COLUMN pinned BOOLEAN NOT NULL DEFAULT false;
  CREATE TABLE artifact_revisions (
    artifact_id TEXT NOT NULL REFERENCES artifacts (id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    size BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    note TEXT,
    pinned BOOLEAN NOT NULL DEFAULT false,
    content BYTEA NOT NULL,
    PRIMARY KEY (artifact_id, n)
  );
  CREATE INDEX artifact_revisions_created ON artifact_revisions (created_at)`;
