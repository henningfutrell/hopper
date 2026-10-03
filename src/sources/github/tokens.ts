// The per-job token keeper: a job comments on its own issue as the app without the app's key.
// Per job it mints an installation token scoped to the job's repo with `issues: write` only and
// keeps it in `<dir>/<sha256(issueUrl)[0..16]>.json` (dir 700, file 600, temp + O_EXCL + rename):
// `{ version: 1, token, expiresAt, repo, issue }`. `refresh` re-mints when a file is missing or
// has under 15 min left and sweeps files of jobs no longer active. Mint failures never throw:
// they are kept per issue url (`errors()`) and the next refresh retries.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../../domain/ports.ts';
import type { Job } from '../../domain/types.ts';
import type { GitHubApi } from './api.ts';

export const TOKEN_FILE_VERSION = 1;
export const REFRESH_BEFORE_MS = 15 * 60_000;

export interface JobTokenKeeper {
  pathFor(issueUrl: string): string;
  /** Mint and write the job's token unless a fresh one is already there. Never throws. */
  ensure(job: Job): Promise<void>;
  /** ensure() every active job; delete every file that belongs to none of them. Never throws. */
  refresh(activeJobs: Job[]): Promise<void>;
  drop(job: Job): void;
  /** Last mint/write failure per issue url, cleared on success. */
  errors(): Record<string, string>;
}

interface JobIssue { url: string; repo: string; number: number }

function issueOf(job: Job): JobIssue | undefined {
  const s = job.source;
  const url = s?.url ?? s?.key;
  return url && s?.repo && s.number ? { url, repo: s.repo, number: s.number } : undefined;
}

export function createJobTokenKeeper(o: { dir: string; api: GitHubApi; clock: Clock }): JobTokenKeeper {
  const errors = new Map<string, string>();
  const fileName = (issueUrl: string) => `${createHash('sha256').update(issueUrl).digest('hex').slice(0, 16)}.json`;
  const pathFor = (issueUrl: string) => join(o.dir, fileName(issueUrl));

  const openDir = () => {
    mkdirSync(o.dir, { recursive: true, mode: 0o700 });
    chmodSync(o.dir, 0o700);
  };

  const fresh = (path: string): boolean => {
    try {
      const f = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; expiresAt?: unknown };
      const exp = typeof f.expiresAt === 'string' ? Date.parse(f.expiresAt) : NaN;
      return f.version === TOKEN_FILE_VERSION && exp - o.clock.now().getTime() >= REFRESH_BEFORE_MS;
    } catch {
      return false;
    }
  };

  const write = (path: string, content: string) => {
    const tmp = join(o.dir, `.${randomUUID()}.tmp`);
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, content);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  };

  const ensureIssue = async (issue: JobIssue): Promise<void> => {
    try {
      openDir();
      const path = pathFor(issue.url);
      if (fresh(path)) return;
      if (!o.api.mintRepoToken) throw new Error('this GitHub adapter cannot mint repo tokens');
      const t = await o.api.mintRepoToken(issue.repo);
      write(path, JSON.stringify({ version: TOKEN_FILE_VERSION, token: t.token, expiresAt: t.expiresAt, repo: issue.repo, issue: issue.number }));
      errors.delete(issue.url);
    } catch (err) {
      errors.set(issue.url, (err as Error).message);
    }
  };

  const sweep = (keep: Set<string>) => {
    let names: string[];
    try {
      names = readdirSync(o.dir);
    } catch {
      return;
    }
    for (const name of names) if (!keep.has(name)) rmSync(join(o.dir, name), { force: true, recursive: true });
  };

  return {
    pathFor,
    async ensure(job) {
      const issue = issueOf(job);
      if (issue) await ensureIssue(issue);
    },
    async refresh(activeJobs) {
      const issues = activeJobs.map(issueOf).filter((i): i is JobIssue => i !== undefined);
      for (const issue of issues) await ensureIssue(issue);
      sweep(new Set(issues.map((i) => fileName(i.url))));
      for (const url of errors.keys()) if (!issues.some((i) => i.url === url)) errors.delete(url);
    },
    drop(job) {
      const issue = issueOf(job);
      if (!issue) return;
      errors.delete(issue.url);
      try {
        unlinkSync(pathFor(issue.url));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') errors.set(issue.url, (err as Error).message);
      }
    },
    errors: () => Object.fromEntries(errors),
  };
}
