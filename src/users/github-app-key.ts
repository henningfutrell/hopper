// A user's GitHub App private key (issue #1243): kept in the vault's system scope, opened at each read, so the app
// source — which reads it by GITHUB_APP_KEY_VARIABLE through the user's runtime secrets — uses a key set, replaced or
// removed at its next sync. A key the runtime still gives is imported once.
import type { UserStore } from '../domain/ports.ts';
import type { User } from '../domain/types.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import { createGitHubAppKey, GITHUB_APP_KEY_VARIABLE, type GitHubAppKey } from '../sources/index.ts';
import type { SystemSecrets } from '../vault/system.ts';

export function userGitHubAppKey(o: {
  user: User; store: UserStore;
  /** The runtime's secrets under the user's prefix; the user's secrets so far (the TypeSafe key's among them); the user's system secrets. */
  runtime: RuntimeSecrets; secret: RuntimeSecrets; system: SystemSecrets;
  clock: { now(): Date };
  logger: { info(line: string): void; warn(line: string): void };
}): { githubAppKey: GitHubAppKey; secret: RuntimeSecrets } {
  const githubAppKey = createGitHubAppKey({
    system: o.system, runtime: o.runtime, variable: `${o.user.secretPrefix}${GITHUB_APP_KEY_VARIABLE}`, backfills: o.store.settings, clock: o.clock, logger: o.logger,
  });
  githubAppKey.importFromEnvironment();
  return { githubAppKey, secret: (name) => (name === GITHUB_APP_KEY_VARIABLE ? githubAppKey.value() : o.secret(name)) };
}
