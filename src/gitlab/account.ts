// A user's GitLab account (issue #1448 part 2, design.md "A GitLab source"): attached with a personal access token, at
// gitlab.com or at a GitLab of the user's own; the projects it reaches read from GitLab, and the projects picked for it. The
// token is a system secret in the user's vault (`gitlab-account.access-token`), sealed under the master key, never in the
// record, a log line or an answer. GitLab must take the token, and the source email match applies, as for a GitHub token.
// GitLab refusing the token later ends this account only (issue #1380, "a source expiring marks only the source"): its
// record is marked, its source pauses, and a new token connects it again. For a job (part 3, design.md "Jobs through GitLab"):
// the account's API for the source's reads and labels, the token for git through the hopper, and who of its GitLab is a
// trusted actor, as Access decides.
import { GITLAB_COM, gitlabBaseUrl, isGitLabProject, type GitLabAccountRecord, type GitLabAccountStatus, type GitLabIssue } from '../domain/gitlab-account.ts';
import type { UserSettingsRepository } from '../domain/settings-store.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { normalEmail } from '../connected-accounts/email-match.ts';
import { NO_KEY } from '../connected-accounts/at-rest.ts';
import { createGitLabApi, GitLabTokenRefused, type GitLabApi, type GitLabIdentity } from './api.ts';
import type { AccessAnswer, GitLabActorRef } from '../domain/access.ts';

const TOKEN = 'gitlab-account.access-token' as const;
const BY = 'hopper';

export interface GitLabAccount {
  status(): GitLabAccountStatus;
  /** Attaches the account the token is, at `baseUrl` (absent: gitlab.com). A refusal keeps nothing and leaves an account there was as it was. */
  connect(o: { token: string; baseUrl?: string }, by?: { email?: string }): Promise<GitLabAccountStatus>;
  /** The projects picked, the whole list. Throws when no account is attached. */
  choose(projects: readonly string[]): GitLabAccountStatus;
  /** Reads the projects the token reaches again. */
  refresh(): Promise<GitLabAccountStatus>;
  /** Forgets the account and its token. The token is the person's: nothing is deleted at GitLab. */
  disconnect(): GitLabAccountStatus;
  /** Why the account's source lists nothing now; undefined: it lists the picked projects' issues. */
  paused(): string | undefined;
  /** The open issues of a picked project with `label`. A refused token ends the account and throws. */
  issues(project: string, label: string): Promise<GitLabIssue[]>;
  /** `fn` with the account's API, while it is connected. A refused token ends the account and throws. */
  act<T>(fn: (api: GitLabApi) => Promise<T>): Promise<T>;
  /** What git through the hopper uses (issue #1448 part 3): the GitLab, the account and its token now; or why there is none. */
  git(): { baseUrl: string; account: string; token: string } | { problem: string };
  /** GitLab refused the token git gave: the account ends, as when the API is refused. */
  refused(error: string): void;
  /** Whether each GitLab user (by id, at the account's GitLab) is a trusted actor of the user (issue #1448 part 3): Access decides. */
  trusted(userIds: readonly number[]): Promise<Map<number, boolean>>;
}

export class NoGitLabAccount extends Error {}

export function createGitLabAccount(o: {
  settings: Pick<UserSettingsRepository, 'getGitLabAccount' | 'setGitLabAccount'>;
  secrets: SystemSecrets;
  clock: { now(): Date };
  /** Whether the source email match is on, read at each connect; absent: on. */
  emailMatch?(): boolean;
  /** The API for a token (tests: a fake GitLab's). */
  api?(baseUrl: string, token: string): GitLabApi;
  /** After an account is attached, picked, ended or removed: its source follows. `presence`: an account came or went, so its source does. */
  onChange?(presence: boolean): void;
  /**
   * Whether a GitLab user may start the user's jobs (issue #1448 part 3): Access (OpenFGA `intake#can_start_jobs`), the account
   * told as the trusted actor. Absent: no Access, so nobody is a trusted actor and no GitLab issue becomes a job.
   */
  startsJobs?(actor: GitLabActorRef, actors: readonly GitLabActorRef[]): Promise<AccessAnswer>;
  logger: { info(line: string): void; warn(line: string): void };
}): GitLabAccount {
  const api = o.api ?? ((baseUrl, token) => createGitLabApi({ baseUrl, token }));
  const now = () => o.clock.now().toISOString();
  const changed = (presence = false) => o.onChange?.(presence);
  let failed: string | undefined; // why the last connect failed, while no account is attached

  const record = () => o.settings.getGitLabAccount();
  const put = (r: GitLabAccountRecord) => o.settings.setGitLabAccount(r);
  /** The token, opened now; undefined: none kept. Throws when it cannot be opened. */
  const token = (): string | undefined => o.secrets.open(TOKEN, 'the GitLab source');
  const unreadable = (): string | undefined => {
    try { token(); return undefined; } catch (err) { return (err as Error).message; }
  };

  function status(): GitLabAccountStatus {
    const r = record();
    if (!r) return { state: 'not-connected', ...(failed ? { error: failed } : {}) };
    const { ended, ...rest } = r;
    if (ended) return { state: 'expired', error: ended.error, ...rest };
    const cannot = unreadable();
    return cannot ? { state: 'unreadable', error: cannot, ...rest } : { state: 'connected', ...rest };
  }

  /** Marks the account ended: GitLab refused its token. Once; nothing else changes. */
  function end(error: string): void {
    const r = record();
    if (!r || r.ended) return;
    put({ ...r, ended: { at: now(), error } });
    o.logger.warn(`hopper: the GitLab account ${r.account} ended: ${error}`);
    changed();
  }

  /** Reads the projects the token reaches into the record. A refused token ends the account. */
  async function readProjects(r: GitLabAccountRecord, t: string): Promise<void> {
    try {
      const reached = await api(r.baseUrl, t).projects();
      const { reachError: _e, ...rest } = record() ?? r;
      put({ ...rest, reached, reachedAt: now() });
    } catch (err) {
      if (err instanceof GitLabTokenRefused) return end(err.message);
      put({ ...(record() ?? r), reachError: (err as Error).message });
    }
  }

  async function act<T>(fn: (a: GitLabApi) => Promise<T>): Promise<T> {
    const r = record();
    const t = r && !r.ended ? token() : undefined;
    if (!r || !t) throw new NoGitLabAccount('no GitLab account is connected');
    try {
      return await fn(api(r.baseUrl, t));
    } catch (err) {
      if (err instanceof GitLabTokenRefused) end(err.message);
      throw err;
    }
  }

  const refusal = (account: string, email: string, verified: readonly string[] | undefined): string | undefined => {
    const want = normalEmail(email);
    const off = 'or ask the hopper\'s admin to turn off the source email match (Settings → Sign-in)';
    if (verified === undefined) return `GitLab did not show the confirmed emails of ${account}, so the hopper cannot check ${want}, the email you signed in with: give a token that may read them (scope read_user or api), ${off}`;
    if (verified.some((e) => normalEmail(e) === want)) return undefined;
    return `the GitLab account ${account} has no confirmed email ${want}, the email you signed in with: add and confirm it at GitLab, then connect again, ${off}`;
  };

  return {
    status,
    async connect({ token: given, baseUrl: url }, by) {
      const refuse = (why: string): GitLabAccountStatus => {
        if (!record()) failed = why;
        o.logger.warn(`hopper: connecting GitLab with a token refused: ${why}`);
        return { state: 'failed', error: why }; // said even over an account there is: it stays as it was
      };
      const baseUrl = gitlabBaseUrl(url ?? GITLAB_COM);
      if (!baseUrl) return refuse('the GitLab URL must be an https URL with no user, query or fragment (http only on this machine)');
      if (o.secrets.problem()) return refuse(NO_KEY);
      let who: GitLabIdentity;
      try {
        who = await api(baseUrl, given).whoIs();
      } catch (err) {
        return refuse(`GitLab refused the token: ${(err as Error).message}`);
      }
      const email = by?.email && (o.emailMatch?.() ?? true) ? by.email : undefined;
      const refused = email === undefined ? undefined : refusal(who.account, email, who.verifiedEmails);
      if (refused) return refuse(refused);
      const kept = o.secrets.keep(TOKEN, given, BY);
      if (!kept.ok) return refuse(`the token cannot be kept: ${kept.error}`);
      const before = record();
      const same = before !== undefined && before.baseUrl === baseUrl && before.userId === who.userId;
      const r: GitLabAccountRecord = {
        baseUrl, account: who.account, userId: who.userId, connectedAt: now(),
        ...(email !== undefined ? { matchEmail: normalEmail(email) } : {}),
        projects: same ? before.projects : [],
      };
      put(r);
      failed = undefined;
      await readProjects(r, given);
      o.logger.info(`hopper: GitLab connected as ${who.account} at ${baseUrl} with a personal access token`);
      changed(before === undefined);
      return status();
    },
    choose(projects) {
      const r = record();
      if (!r) throw new NoGitLabAccount('no GitLab account is connected: Sources → Connect GitLab');
      const bad = projects.find((p) => !isGitLabProject(p));
      if (bad !== undefined) throw new Error(`not a GitLab project path: ${bad}`);
      put({ ...r, projects: [...new Set(projects)] });
      changed();
      return status();
    },
    async refresh() {
      const r = record();
      if (!r) throw new NoGitLabAccount('no GitLab account is connected: Sources → Connect GitLab');
      const t = r.ended ? undefined : token();
      if (t) await readProjects(r, t);
      return status();
    },
    disconnect() {
      const r = record();
      o.secrets.drop(TOKEN, BY);
      o.settings.setGitLabAccount(null);
      failed = undefined;
      if (r) { o.logger.info(`hopper: the GitLab account ${r.account} was removed`); changed(true); }
      return status();
    },
    paused() {
      const s = status();
      if (s.state === 'not-connected') return 'no GitLab account is connected: Sources → Connect GitLab';
      if (s.state === 'expired') return `GitLab refused the token of ${s.account}: connect it again with a new token (Sources → GitLab)`;
      if (s.state !== 'connected') return `the GitLab token cannot be opened: ${s.error}`;
      if (s.projects.length === 0) return 'no GitLab project is picked: pick them in Sources → GitLab';
      return undefined;
    },
    issues: (project, label) => act((a) => a.issues(project, label)),
    act,
    git() {
      const r = record();
      if (!r) return { problem: 'no GitLab account is connected: Sources → Connect GitLab' };
      if (r.ended) return { problem: `GitLab refused the token of ${r.account}: connect it again with a new token (Sources → GitLab)` };
      try {
        const t = token();
        return t ? { baseUrl: r.baseUrl, account: r.account, token: t } : { problem: 'the GitLab account has no token kept: connect it again (Sources → GitLab)' };
      } catch (err) {
        return { problem: `the GitLab token cannot be opened: ${(err as Error).message}` };
      }
    },
    refused: (error) => end(error),
    async trusted(userIds) {
      const r = record();
      const out = new Map<number, boolean>();
      if (!r || !o.startsJobs) return out;
      const self = { baseUrl: r.baseUrl, userId: r.userId };
      for (const id of new Set(userIds)) {
        const answer = await o.startsJobs({ baseUrl: r.baseUrl, userId: id }, [self]).catch(() => ({ allowed: false }));
        out.set(id, answer.allowed);
      }
      return out;
    },
  };
}
