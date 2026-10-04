// The app's credentials, via `@octokit/auth-app`: a JWT signed with the private key (for the
// `/app/*` endpoints and the per-repo installation lookup) and installation tokens (cached by
// the library).

import { createAppAuth } from '@octokit/auth-app';
import type { GitHubApp } from './config.ts';
import type { Request } from './http.ts';

export interface AppAuth {
  /** A JWT for the app itself (RS256, ≤ 10 min). */
  jwt(): Promise<string>;
  /** An installation token covering every repo of the installation (library-cached). */
  installationToken(installationId: number): Promise<string>;
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
  };
}
