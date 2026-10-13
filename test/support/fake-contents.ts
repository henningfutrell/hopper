// The fake GitHub's branches and files (issue #946, Promote to GitHub's committed artifacts), for
// test/support/fake-forges.ts: a branch's ref read and made (`GET …/git/ref/heads/{branch}`, `POST …/git/refs`), and a
// file read and written on a branch through the contents API (`GET`/`PUT …/contents/{path}`). Every repository has its
// default branch `dev`; a write to a file that is there needs its `sha`, as on GitHub.
import { createHash } from 'node:crypto';

/** A file as written on the fake: its content, its blob sha and the commit message that wrote it. */
export interface FakeFile { content: string; sha: string; message: string }

/** The fake GitHub's options for it (fields of `FakeForge`). */
export interface ContentsForge {
  /** GitHub: the branches made, by `owner/name@branch` → the sha it was made at. Each repository's `dev` is there too. */
  branches?: Record<string, string>;
  /** GitHub: the files written, by `owner/name@branch:path`. */
  files?: Record<string, FakeFile>;
}

const DEFAULT_SHA = 'f'.repeat(40);

/** The answer to a ref or contents request of `repo`; undefined: `rest` is neither. */
export function contentsRoute(f: ContentsForge, base: string, method: string, repo: string, raw: string, query: Record<string, string>, body: Record<string, unknown>): { status: number; body: unknown } | undefined {
  const branches = (f.branches ??= {});
  const files = (f.files ??= {});
  // A client may send a ref or a path with its slashes encoded (`heads%2Fname`), as @octokit/request does.
  const rest = decodeURIComponent(raw);
  const shaOf = (branch: string): string | undefined => branches[`${repo}@${branch}`] ?? (branch === 'dev' ? DEFAULT_SHA : undefined);
  const ref = /^git\/ref\/heads\/(.+)$/.exec(rest);
  if (method === 'GET' && ref) {
    const branch = ref[1]!;
    const sha = shaOf(branch);
    return sha ? { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } } : { status: 404, body: { message: 'Not Found' } };
  }
  if (method === 'POST' && rest === 'git/refs') {
    const branch = String(body.ref).replace(/^refs\/heads\//, '');
    if (shaOf(branch)) return { status: 422, body: { message: 'Reference already exists' } };
    branches[`${repo}@${branch}`] = String(body.sha);
    return { status: 201, body: { ref: body.ref, object: { sha: body.sha } } };
  }
  const c = /^contents\/(.+)$/.exec(rest);
  if (!c) return undefined;
  const path = c[1]!;
  if (method === 'GET') {
    const file = files[`${repo}@${query.ref ?? 'dev'}:${path}`];
    return file ? { status: 200, body: { type: 'file', path, sha: file.sha } } : { status: 404, body: { message: 'Not Found' } };
  }
  if (method !== 'PUT') return undefined;
  const branch = String(body.branch ?? 'dev');
  if (!shaOf(branch)) return { status: 404, body: { message: `Branch ${branch} not found` } };
  const key = `${repo}@${branch}:${path}`;
  const was = files[key];
  if (was && body.sha !== was.sha) return { status: 409, body: { message: `${path} does not match ${String(body.sha)}` } };
  if (!was && body.sha !== undefined) return { status: 404, body: { message: 'Not Found' } };
  const content = Buffer.from(String(body.content), 'base64').toString('utf8');
  const sha = createHash('sha1').update(content).digest('hex');
  files[key] = { content, sha, message: String(body.message) };
  return { status: was ? 200 : 201, body: { content: { path, sha, html_url: `${base}/${repo}/blob/${branch}/${path}` }, commit: { sha: createHash('sha1').update(`${key}${sha}`).digest('hex') } } };
}
