// The user's GitLab account (issue #1448 part 2), apart from settings.ts for its size: a user's key-value setting, `null`
// once removed, absent when never attached. Never its token: that is a system secret in the user's vault.
import type { GitLabAccountRecord } from '../domain/gitlab-account.ts';

export function gitlabAccountSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getGitLabAccount(): GitLabAccountRecord | undefined;
  setGitLabAccount(account: GitLabAccountRecord | null): void;
} {
  return {
    getGitLabAccount() {
      const text = read('gitlabAccount');
      return (text === undefined ? null : JSON.parse(text) as GitLabAccountRecord | null) ?? undefined;
    },
    setGitLabAccount(account) {
      write('gitlabAccount', JSON.stringify(account));
    },
  };
}
