// A library skill's folder read from a GitHub repository (issue #1911, design.md "Importing a skill"), with the user's own
// GitHub connection — the account of the repository —, never a job's: the ref's head commit, the trees down to the folder,
// the folder's tree, then each file's blob. Text files only. The same `@octokit/request` binding and token renewal as
// Promote to GitHub (src/promotions/github.ts).
import { skillTreeFiles, type SkillTreeEntry } from '../domain/skill-library.ts';
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/http/http.ts';

/** What a read found: the commit and the folder's files; or why it is no skill (`missing`: no such repository, ref or folder). */
export type SkillFolder = { commit: string; files: Record<string, string> } | { problem: string; missing?: true };

export interface SkillSourceGitHub {
  read(repo: string, path: string, ref: string): Promise<SkillFolder>;
}

/** GitHub's failure, not the folder's: it says GitHub's status and message. */
export class SkillSourceGitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillSourceGitHubError';
  }
}

/** The bytes as UTF-8 text; undefined: they are no text. */
function textOf(bytes: Buffer): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return text.includes('\u0000') ? undefined : text;
  } catch {
    return undefined;
  }
}

interface Tree { tree: SkillTreeEntry[]; truncated?: boolean }

export function createSkillSourceGitHub(o: { apiUrl: string } & TokenSource): SkillSourceGitHub {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new SkillSourceGitHubError(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`);
  };
  return {
    read: (repo, path, ref) => withToken(async (token): Promise<SkillFolder> => {
      const at = { ...splitRepo(repo), headers: { authorization: `token ${token}` } };
      const where = `${repo}${path ? `/${path}` : ''} at ${ref}`;
      const none: SkillFolder = { problem: `no folder ${where}`, missing: true };
      const get = async <T>(route: string, params: Record<string, unknown>): Promise<T | undefined> => {
        try {
          return (await req(route, { ...at, ...params })).data as T;
        } catch (err) {
          if (statusOf(err) === 404 || statusOf(err) === 422) return undefined;
          throw err;
        }
      };
      const commit = (await get<{ sha: string }>('GET /repos/{owner}/{repo}/commits/{ref}', { ref }))?.sha;
      if (!commit) return none;
      // Down the folder's path one tree at a time: a large repository's whole tree is never read.
      let sha = commit;
      for (const part of path === '' ? [] : path.split('/')) {
        const next = (await get<Tree>('GET /repos/{owner}/{repo}/git/trees/{sha}', { sha }))?.tree.find((e) => e.path === part && e.type === 'tree')?.sha;
        if (!next) return none;
        sha = next;
      }
      const folder = await get<Tree>('GET /repos/{owner}/{repo}/git/trees/{sha}', { sha, recursive: '1' });
      if (!folder) return none;
      if (folder.truncated) return { problem: `GitHub listed only part of ${where}: name a smaller folder` };
      const chosen = skillTreeFiles(folder.tree);
      if ('problem' in chosen) return { problem: `${where}: ${chosen.problem}` };
      const files: Record<string, string> = {};
      for (const f of chosen.files) {
        const blob = await get<{ content: string; encoding: string }>('GET /repos/{owner}/{repo}/git/blobs/{sha}', { sha: f.sha });
        if (!blob) return none;
        const bytes = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8');
        const text = textOf(bytes);
        if (text === undefined) return { problem: `${where}: ${f.path} is no text file; a skill holds text files only` };
        files[f.path] = text;
      }
      return { commit, files };
    }, failed(`the skill folder ${repo}/${path} at ${ref}`)),
  };
}
