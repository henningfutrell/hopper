// A step schedule's files read from GitHub (issue #2716, design.md "Step schedules"), with the user's own GitHub
// connection — the account of the repository —, never a job's: the repository's default branch, its head commit, the
// trees down to the folder, the folder's tree, then each file's blob, as bytes. The same reads as a library skill's
// folder (src/skill-library/github.ts), but any file, and its mode.
import { tokenCaller, type TokenSource } from '../github-proxy/index.ts';
import { makeRequest, splitRepo, statusOf } from '../sources/github/http/http.ts';

/** The most a schedule's folder may hold: as a box step's inputs (src/sandbox/need-steps.ts). */
export const SCHEDULE_FILES_MAX_BYTES = 32 * 1024 * 1024;
/** The most files a schedule's folder may hold. */
export const SCHEDULE_FILES_MAX = 1000;

/** One file of the folder: its path in the repository, its bytes, and whether git keeps it executable. */
export interface ScheduleFile { path: string; data: Buffer; executable: boolean }

/** What a read found: the commit and the folder's files; or why not. */
export type ScheduleFolder = { commit: string; files: ScheduleFile[] } | { problem: string };

export interface ScheduleSourceGitHub {
  /** The folder `path` of `repo` at its default branch. */
  read(repo: string, path: string): Promise<ScheduleFolder>;
}

interface TreeEntry { path: string; type: string; sha: string; mode: string; size?: number }
interface Tree { tree: TreeEntry[]; truncated?: boolean }

export function createScheduleSourceGitHub(o: { apiUrl: string } & TokenSource): ScheduleSourceGitHub {
  const req = makeRequest(o.apiUrl);
  const withToken = tokenCaller(o);
  const failed = (what: string) => (err: unknown): Error => {
    const e = err as { message?: unknown; response?: { data?: { message?: unknown } } };
    const message = typeof e.response?.data?.message === 'string' ? e.response.data.message : String(e.message ?? err);
    return new Error(`GitHub answered ${statusOf(err) ?? 'no status'} to ${what}: ${message}`);
  };
  return {
    read: (repo, path) => withToken(async (token): Promise<ScheduleFolder> => {
      const at = { ...splitRepo(repo), headers: { authorization: `token ${token}` } };
      const get = async <T>(route: string, params: Record<string, unknown>): Promise<T | undefined> => {
        try {
          return (await req(route, { ...at, ...params })).data as T;
        } catch (err) {
          if (statusOf(err) === 404 || statusOf(err) === 422) return undefined;
          throw err;
        }
      };
      const branch = (await get<{ default_branch: string }>('GET /repos/{owner}/{repo}', {}))?.default_branch;
      if (!branch) return { problem: `no repository ${repo} that the connected account can read` };
      const where = `${repo}/${path} at ${branch}`;
      const none = { problem: `no folder ${where}` };
      const commit = (await get<{ sha: string }>('GET /repos/{owner}/{repo}/commits/{ref}', { ref: branch }))?.sha;
      if (!commit) return none;
      // Down the folder's path one tree at a time: a large repository's whole tree is never read.
      let sha = commit;
      for (const part of path.split('/')) {
        const next = (await get<Tree>('GET /repos/{owner}/{repo}/git/trees/{sha}', { sha }))?.tree.find((e) => e.path === part && e.type === 'tree')?.sha;
        if (!next) return none;
        sha = next;
      }
      const folder = await get<Tree>('GET /repos/{owner}/{repo}/git/trees/{sha}', { sha, recursive: '1' });
      if (!folder) return none;
      if (folder.truncated) return { problem: `GitHub listed only part of ${where}: name a smaller folder` };
      // Files only: a link or a submodule is not read.
      const blobs = folder.tree.filter((e) => e.type === 'blob' && e.mode !== '120000');
      if (blobs.length > SCHEDULE_FILES_MAX) return { problem: `${where} holds ${blobs.length} files: at most ${SCHEDULE_FILES_MAX}` };
      const size = blobs.reduce((n, e) => n + (e.size ?? 0), 0);
      if (size > SCHEDULE_FILES_MAX_BYTES) return { problem: `${where} holds ${size} bytes: at most ${SCHEDULE_FILES_MAX_BYTES}` };
      const files: ScheduleFile[] = [];
      for (const e of blobs) {
        const blob = await get<{ content: string; encoding: string }>('GET /repos/{owner}/{repo}/git/blobs/{sha}', { sha: e.sha });
        if (!blob) return none;
        files.push({ path: `${path}/${e.path}`, data: Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8'), executable: e.mode === '100755' });
      }
      return { commit, files };
    }, failed(`the folder ${repo}/${path}`)),
  };
}
