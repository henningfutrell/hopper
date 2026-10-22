// Git through the hopper (issue #652, design.md "Git through the hopper"): a job's git fetch and push go to the hopper,
// which does them on GitHub with the connection of the job's own user — the job's machine holds no GitHub token. What a
// push may change is read from the ref updates at the head of git's receive-pack request, before anything reaches
// GitHub: a branch of the job's own work, never the default branch, a release branch, a tag or a delete — but the target
// branch with direct push on (issue #1806). Pure: no I/O.

import { BATCH_BRANCH_PREFIX, RELEASE_BRANCHES } from '../domain/landing-batches.ts';

/** The route on the hopper's URL a job's git goes to: `<HOPPER_URL>/job/git/<owner>/<name>.git/…`. */
export const GIT_PATH = '/job/git/';

/** The git services the hopper takes: a fetch (`git-upload-pack`) and a push (`git-receive-pack`). */
export type GitService = 'git-upload-pack' | 'git-receive-pack';

/** One ref update of a push: the ref, from `old` to `new` (40 zeros: none). */
export interface RefUpdate { old: string; new: string; ref: string }

const ZERO = /^0+$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const NAME = /^[A-Za-z0-9_.-]+$/;

/** A git request's path after `GIT_PATH`: its repository and service; undefined for anything else (dumb HTTP included). */
export function gitPath(path: string, service: string | undefined): { repo: string; service: GitService; advertise: boolean } | undefined {
  const m = /^([^/]+)\/([^/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  // A repository name may start with a dot (`.github`, issue #867); `.`, `..` and `.git` are no repository. An owner never does.
  if (!m || !NAME.test(m[1]!) || !NAME.test(m[2]!) || m[1]!.startsWith('.') || ['.', '..', '.git'].includes(m[2]!)) return undefined;
  const repo = `${m[1]}/${m[2]}`;
  if (m[3] !== 'info/refs') return { repo, service: m[3] as GitService, advertise: false };
  return service === 'git-upload-pack' || service === 'git-receive-pack' ? { repo, service, advertise: true } : undefined;
}

/**
 * The ref updates at the head of a receive-pack request: pkt-lines up to the first flush, the first carrying git's
 * capabilities after a NUL; and the pack after them (issue #1096: the shrink guard reads it). A signed push and a push from a shallow clone are not read: neither is what a job sends.
 * A refused one still gives the ref updates it read (issue #2481: a shallow clone's `shallow` lines come before them), so
 * the refusal is git's own, an `ng` line per ref.
 */
export function receivePackCommands(body: Buffer): { ok: true; commands: RefUpdate[]; pack: Buffer } | { ok: false; reason: string; commands: RefUpdate[] } {
  const commands: RefUpdate[] = [];
  let at = 0;
  let shallow = false;
  for (;;) {
    const size = /^[0-9a-f]{4}$/.test(body.toString('latin1', at, at + 4)) ? parseInt(body.toString('latin1', at, at + 4), 16) : -1;
    if (size < 0 || (size > 0 && size < 4) || at + Math.max(size, 4) > body.length) return { ok: false, reason: 'not a git push', commands: [] };
    if (size === 0) { at += 4; break; }
    const line = body.toString('utf8', at + 4, at + size).replace(/\n$/, '').split('\0')[0]!;
    at += size;
    if (line === 'push-cert') return { ok: false, reason: 'a signed push (push-cert) is not taken', commands: [] };
    if (line.startsWith('shallow ')) { shallow = true; continue; }
    const [old, next, ref, ...rest] = line.split(' ');
    if (!old || !next || !ref || rest.length > 0 || !SHA.test(old) || !SHA.test(next)) return { ok: false, reason: 'not a git push', commands: [] };
    commands.push({ old, new: next, ref });
  }
  if (shallow) return { ok: false, reason: 'a push from a shallow clone is not taken: fetch the full history first (git fetch --unshallow), then push again', commands };
  // The pack follows the commands (after the push options, when git sends any); none when the push sends no object.
  const packAt = body.indexOf('PACK', at, 'latin1');
  const pack = packAt < 0 ? Buffer.alloc(0) : body.subarray(packAt);
  return commands.length === 0 ? { ok: false, reason: 'the push names no ref', commands } : { ok: true, commands, pack };
}

/**
 * git's probe before a push whose pack is over its `http.postBuffer` (issue #2481): a flush packet only, to learn whether
 * the request is taken before it sends the pack chunked. git shows nothing of the probe's answer but its HTTP status.
 */
export const isProbe = (body: Buffer): boolean => body.length === 4 && body.toString('latin1') === '0000';

/**
 * Whether a job may make these ref updates on a repository whose default branch is `defaultBranch`. `direct` (issue #1806):
 * the target branch a job may push straight to, with direct push on; the broker checks that such a push is a fast-forward.
 */
export function checkPush(commands: readonly RefUpdate[], at: { defaultBranch?: string; direct?: string }): { ok: true } | { ok: false; reason: string } {
  const direct = at.direct?.toLowerCase();
  const kept = [...RELEASE_BRANCHES, ...(at.defaultBranch ? [at.defaultBranch.toLowerCase()] : [])].filter((b) => b !== direct);
  for (const c of commands) {
    if (!c.ref.startsWith('refs/heads/')) return { ok: false, reason: `a job pushes branches only, not ${c.ref}` };
    const branch = c.ref.slice('refs/heads/'.length);
    if (kept.includes(branch.toLowerCase())) {
      return { ok: false, reason: `a job pushes only to a branch of its own work, never to ${branch}: push a new branch and open a pull request` };
    }
    // A batch run's branch (issue #1073) is the hopper's: what its checks test is what it merges.
    if (branch.toLowerCase().startsWith(BATCH_BRANCH_PREFIX)) return { ok: false, reason: `a job pushes only to a branch of its own work, never to a batch run's branch (${branch})` };
    if (ZERO.test(c.new)) return { ok: false, reason: `a job deletes no branch (${c.ref})` };
  }
  return { ok: true };
}

/**
 * The variables that send a job's git to the hopper (`git config` from the environment): every GitHub remote — https,
 * ssh and scp-like — is rewritten to `<hopperUrl>/job/git/`, and git's credential ask there is answered from the job's
 * token file (`HOPPER_TOKEN_FILE`), read when git asks: the token is never in a variable. Any other credential helper is
 * cleared for that URL first. `gitlab` (issue #1448 part 3, a GitLab job's): its GitLab's https URL is rewritten to
 * `<hopperUrl>/<gitlab.path>` the same way. `traceparent` (issue #1486 part 6): the job's trace parent, sent as the
 * `traceparent` header to those hopper routes only, so the hopper's span for a fetch or a push is a child of the job's
 * run span; only a value of lowercase hex and dashes, as a W3C trace parent is, so it cannot add a header.
 */
export function jobGitConfig(hopperUrl: string, webUrl: string, gitlab?: { url: string; path: string }, traceparent?: string): Record<string, string> {
  const hopper = hopperUrl.replace(/\/+$/, '');
  const to = `${hopper}${GIT_PATH}`;
  const web = new URL(webUrl);
  const from = [`${web.origin}/`, `git@${web.hostname}:`, `ssh://git@${web.hostname}/`];
  const helper = '!f() { test "$1" = get || exit 0; echo username=hopper-job; printf \'password=%s\\n\' "$(cat "$HOPPER_TOKEN_FILE")"; }; f';
  const trace = traceparent && /^[0-9a-f-]+$/.test(traceparent) ? `traceparent: ${traceparent}` : undefined;
  const via = (url: string): [string, string][] => [[`credential.${url}.helper`, ''], [`credential.${url}.helper`, helper], ...(trace ? [[`http.${url}.extraHeader`, trace] as [string, string]] : [])];
  const toGitLab = gitlab ? `${hopper}${gitlab.path}` : undefined;
  const entries: [string, string][] = [
    ...from.map((f): [string, string] => [`url.${to}.insteadOf`, f]),
    ...via(to),
    ...(gitlab && toGitLab ? [[`url.${toGitLab}.insteadOf`, `${gitlab.url.replace(/\/+$/, '')}/`] as [string, string], ...via(toGitLab)] : []),
  ];
  return {
    GIT_CONFIG_COUNT: String(entries.length),
    ...Object.fromEntries(entries.flatMap(([k, v], i) => [[`GIT_CONFIG_KEY_${i}`, k], [`GIT_CONFIG_VALUE_${i}`, v]])),
  };
}
