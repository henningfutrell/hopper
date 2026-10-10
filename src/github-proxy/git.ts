// Git through the hopper (issue #652, design.md "Git through the hopper"): a job's git fetch and push go to the hopper,
// which does them on GitHub with the connection of the job's own user — the job's machine holds no GitHub token. What a
// push may change is read from the ref updates at the head of git's receive-pack request, before anything reaches
// GitHub: a branch of the job's own work, never the default branch, a release branch, a tag or a delete. Pure: no I/O.

/** The route on the hopper's URL a job's git goes to: `<HOPPER_URL>/job/git/<owner>/<name>.git/…`. */
export const GIT_PATH = '/job/git/';

/** The git services the hopper takes: a fetch (`git-upload-pack`) and a push (`git-receive-pack`). */
export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** One ref update of a push: the ref, from `old` to `new` (40 zeros: none). */
export interface RefUpdate { old: string; new: string; ref: string }

/** Branches no job pushes to, whatever the repository's default branch is: the release branches. */
export const RELEASE_BRANCHES: readonly string[] = ['main', 'master', 'dev', 'beta', 'stable'];

const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NAME = /^[A-Za-z0-9_.-]+$/;

/** A git request's path after `GIT_PATH`: its repository and service; undefined for anything else (dumb HTTP included). */
export function gitPath(path: string, service: string | undefined): { repo: string; service: GitService; advertise: boolean } | undefined {
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (!m || !NAME.test(m[1]!) || !NAME.test(m[2]!) || m[1]!.startsWith('.') || m[2]!.startsWith('.')) return undefined;
  const repo = `${m[1]}/${m[2]}`;
  if (m[3] !== 'info/refs') return { repo, service: m[3] as GitService, advertise: false };
  return service === 'git-upload-pack' || service === 'git-receive-pack' ? { repo, service, advertise: true } : undefined;
}

/**
 * The ref updates at the head of a receive-pack request: pkt-lines up to the first flush, the first carrying git's
 * capabilities after a NUL. A signed push and a push from a shallow clone are not read: neither is what a job sends.
 */
export function receivePackCommands(body: Buffer): { ok: true; commands: RefUpdate[] } | { ok: false; reason: string } {
  const commands: RefUpdate[] = [];
  let at = 0;
  for (;;) {
    const size = /^[0-9a-f]{4}$/.test(body.toString('latin1', at, at + 4)) ? parseInt(body.toString('latin1', at, at + 4), 16) : -1;
    if (size < 0 || (size > 0 && size < 4) || at + Math.max(size, 4) > body.length) return { ok: false, reason: 'not a git push' };
    if (size === 0) break;
    const line = body.toString('utf8', at + 4, at + size).replace(/\n$/, '').split('\0')[0]!;
    at += size;
    if (line === 'push-cert') return { ok: false, reason: 'a signed push (push-cert) is not taken' };
    if (line.startsWith('shallow ')) return { ok: false, reason: 'a push from a shallow clone is not taken: fetch the full history first' };
    const [old, next, ref, ...rest] = line.split(' ');
    if (!old || !next || !ref || rest.length > 0 || !SHA.test(old) || !SHA.test(next)) return { ok: false, reason: 'not a git push' };
    commands.push({ old, new: next, ref });
  }
  return commands.length === 0 ? { ok: false, reason: 'the push names no ref' } : { ok: true, commands };
}

/** Whether a job may make these ref updates on its own repository, whose default branch is `defaultBranch`. */
export function checkPush(commands: readonly RefUpdate[], at: { defaultBranch?: string }): { ok: true } | { ok: false; reason: string } {
  const kept = [...RELEASE_BRANCHES, ...(at.defaultBranch ? [at.defaultBranch.toLowerCase()] : [])];
  for (const c of commands) {
    if (!c.ref.startsWith('refs/heads/')) return { ok: false, reason: `a job pushes branches only, not ${c.ref}` };
    const branch = c.ref.slice('refs/heads/'.length);
    if (kept.includes(branch.toLowerCase())) {
      return { ok: false, reason: `a job pushes only to a branch of its own work, never to ${branch}: push a new branch and open a pull request` };
    }
    if (ZERO.test(c.new)) return { ok: false, reason: `a job deletes no branch (${c.ref})` };
  }
  return { ok: true };
}

/**
 * The variables that send a job's git to the hopper (`git config` from the environment): every GitHub remote — https,
 * ssh and scp-like — is rewritten to `<hopperUrl>/job/git/`, and git's credential ask there is answered from the job's
 * token file (`HOPPER_TOKEN_FILE`), read when git asks: the token is never in a variable. Any other credential helper is
 * cleared for that URL first.
 */
export function jobGitConfig(hopperUrl: string, webUrl: string): Record<string, string> {
  const to = `${hopperUrl.replace(/\/+$/, '')}${GIT_PATH}`;
  const web = new URL(webUrl);
  const from = [`${web.origin}/`, `git@${web.hostname}:`, `ssh://git@${web.hostname}/`];
  const helper = '!f() { test "$1" = get || exit 0; echo username=hopper-job; printf \'password=%s\\n\' "$(cat "$HOPPER_TOKEN_FILE")"; }; f';
  const entries: [string, string][] = [
    ...from.map((f): [string, string] => [`url.${to}.insteadOf`, f]),
    [`credential.${to}.helper`, ''],
    [`credential.${to}.helper`, helper],
  ];
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(entries.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
}
