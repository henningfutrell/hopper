// The fake GitHub's git trees and blobs (issue #1911, a skill imported from a repository), for test/support/fake-forges.ts:
// `GET …/git/trees/{sha}` lists a folder of a commit — the commit a ref's head names (`heads`, HeadsForge) — or of a
// tree it listed before, `?recursive=1` everything under it; `GET …/git/blobs/{sha}` answers a file's content in base64.
// The files are ContentsForge's (`owner/name@ref:path`); a ref `HEAD` reads the default branch `dev`.
import { createHash } from 'node:crypto';
import type { ContentsForge } from './fake-contents.ts';
import type { HeadsForge } from './fake-heads.ts';

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** The answer to a tree or blob read of `repo`; undefined: `rest` is neither. */
export function skillTreeRoute(f: ContentsForge & HeadsForge, method: string, repo: string, rest: string, query: Record<string, string>): { status: number; body: unknown } | undefined {
  const m = /^git\/(trees|blobs)\/([^/]+)$/.exec(rest);
  if (method !== 'GET' || !m) return undefined;
  const files = Object.entries(f.files ?? {}).filter(([k]) => k.startsWith(`${repo}@`));
  if (m[1] === 'blobs') {
    const file = files.find(([, v]) => v.sha === m[2])?.[1];
    return file ? { status: 200, body: { sha: file.sha, encoding: 'base64', content: Buffer.from(file.content).toString('base64') } } : { status: 404, body: { message: 'Not Found' } };
  }
  // Each ref's head commit is its root tree; each folder of a ref is a tree named by a hash of where it is.
  const roots = Object.entries(f.heads ?? {}).filter(([k]) => k.startsWith(`${repo}@`)).map(([k, sha]) => ({ ref: k.slice(repo.length + 1), dir: '', sha }));
  const at = [...roots, ...roots.flatMap((r) => dirsOf(files, r.ref).map((dir) => ({ ref: r.ref, dir, sha: sha1(`${repo}@${r.ref}:${dir}`) })))].find((t) => t.sha === m[2]);
  if (!at) return { status: 404, body: { message: 'Not Found' } };
  const branch = at.ref === 'HEAD' ? 'dev' : at.ref;
  const prefix = `${repo}@${branch}:${at.dir === '' ? '' : `${at.dir}/`}`;
  const under = files.filter(([k]) => k.startsWith(prefix)).map(([k, v]) => ({ path: k.slice(prefix.length), file: v }));
  const recursive = query.recursive !== undefined;
  const tree = new Map<string, unknown>();
  for (const { path, file } of under) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (recursive || i === 1) tree.set(dir, { path: dir, type: 'tree', sha: sha1(`${repo}@${at.ref}:${at.dir === '' ? dir : `${at.dir}/${dir}`}`) });
    }
    if (recursive || parts.length === 1) tree.set(path, { path, type: 'blob', sha: file.sha, size: Buffer.byteLength(file.content) });
  }
  return { status: 200, body: { sha: m[2], truncated: false, tree: [...tree.values()] } };
}

/** Every folder of `ref`'s files. */
function dirsOf(files: [string, { content: string }][], ref: string): string[] {
  const repoAt = files[0]?.[0].split('@')[0] ?? '';
  const prefix = `${repoAt}@${ref === 'HEAD' ? 'dev' : ref}:`;
  const dirs = new Set<string>();
  for (const [k] of files.filter(([k]) => k.startsWith(prefix))) {
    const parts = k.slice(prefix.length).split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return [...dirs];
}
