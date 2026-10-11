// The app's credentials, via `@octokit/auth-app`: a JWT signed with the private key (for the
// `/app/*` endpoints and the per-repo installation lookup) and installation tokens (cached by
// the library; one asking at a time for each installation, issue #822).

import { createAppAuth } from '@octokit/auth-app';
import type { GitHubApp } from './config.ts';
import type { Request } from './http.ts';

export interface AppAuth {
  /** A JWT for the app itself (RS256, ≤ 10 min). */
  jwt(): Promise<string>;
  /** An installation token covering every repo of the installation (library-cached; the calls made while it is asked wait on it). */
  installationToken(installationId: number): Promise<string>;
}

export function createAuth(app: GitHubApp, request: Request): AppAuth {
  const auth = createAppAuth({ appId: app.appId, privateKey: app.privateKey, request });
  const asking = new Map<number, Promise<string>>();
  return {
    async jwt() {
      return (await auth({ type: 'app' })).token;
    },
    installationToken(installationId) {
      const asked = asking.get(installationId);
      if (asked) return asked;
      const token = auth({ type: 'installation', installationId }).then((a) => a.token).finally(() => asking.delete(installationId));
      asking.set(installationId, token);
      return token;
    },
  };
}
