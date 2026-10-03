// The app's credentials, via `@octokit/auth-app`: a JWT signed with the private key (for the
// `/app/*` endpoints and the per-repo installation lookup), installation tokens (cached by the
// library), and fresh repo-scoped tokens for jobs.

import { createAppAuth } from '@octokit/auth-app';
import type { GitHubApp } from './config.ts';
import type { Request } from './http.ts';

export interface AppAuth {
  /** A JWT for the app itself (RS256, ≤ 10 min). */
  jwt(): Promise<string>;
  /** An installation token covering every repo of the installation (library-cached). */
  installationToken(installationId: number): Promise<string>;
  /** A new token for one repo with `issues: write` only. Never cached: each call mints. */
  mint(installationId: number, repoName: string): Promise<{ token: string; expiresAt: string }>;
}

export function createAuth(app: GitHubApp, request: Request): AppAuth {
  const auth = createAppAuth({ appId: app.appId, privateKey: app.privateKey, request });
  return {
    async jwt() {
      return (await auth({ type: 'app' })).token;
    },
    async installationToken(installationId) {
      return (await auth({ type: 'installation', installationId })).token;
    },
    async mint(installationId, repoName) {
      // refresh: the library caches tokens for 59 min per options; without it a "refresh" would
      // hand back the same token, close to expiry (design B2).
      const a = await auth({
        type: 'installation', installationId, repositoryNames: [repoName], permissions: { issues: 'write' }, refresh: true,
      });
      return { token: a.token, expiresAt: a.expiresAt };
    },
  };
}
