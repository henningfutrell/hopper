// The github realm: GitHub (github.com or GitHub Enterprise Server) as the identity provider. GitHub's OAuth app is
// OAuth 2.0, not OIDC: no ID token, so the identity comes from the REST API with the user's token —
// the user, their primary verified email, and, when a role rule names groups, their teams as
// `org/team-slug`. openid-client drives the authorization code grant with PKCE and state.
import * as client from 'openid-client';
import type { Identity } from '../domain/types.ts';
import type { GithubRealmConfig } from './config.ts';
import { isLoopbackHttp, stringOf, type RedirectRealm } from './realm.ts';

const usesGroups = (c: GithubRealmConfig): boolean => [c.roles.admin, c.roles.operator, c.roles.viewer].some((m) => (m?.groups?.length ?? 0) > 0);

export function createGithubRealm(c: GithubRealmConfig, redirectUri: string): RedirectRealm {
  const web = c.webUrl.replace(/\/$/, '');
  const api = c.apiUrl.replace(/\/$/, '');
  const config = new client.Configuration(
    { issuer: web, authorization_endpoint: `${web}/login/oauth/authorize`, token_endpoint: `${web}/login/oauth/access_token` },
    c.clientId, { client_secret: c.clientSecret }, client.ClientSecretPost(c.clientSecret),
  );
  if (isLoopbackHttp(web) || isLoopbackHttp(api)) client.allowInsecureRequests(config);
  const scope = ['read:user', 'user:email', ...(usesGroups(c) ? ['read:org'] : [])].join(' ');

  async function read<T>(token: string, path: string): Promise<T> {
    const headers = new Headers({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    const res = await client.fetchProtectedResource(config, token, new URL(`${api}${path}`), 'GET', undefined, headers);
    if (!res.ok) throw new Error(`GitHub ${path} answered ${res.status}`);
    return await res.json() as T;
  }

  return {
    name: c.name, label: c.label, type: 'github',
    async start(flowId) {
      const verifier = client.randomPKCECodeVerifier();
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri, scope, state: flowId, allow_signup: 'false',
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      return { url: url.href, secrets: { verifier, state: flowId } };
    },
    flowIdOf: (cb) => cb.url.searchParams.get('state') ?? undefined,
    async finish(cb, secrets) {
      const tokens = await client.authorizationCodeGrant(config, cb.url, { pkceCodeVerifier: secrets.verifier!, expectedState: secrets.state! }, { redirect_uri: redirectUri });
      const user = await read<{ id: number; login: string; name?: string | null }>(tokens.access_token, '/user');
      const emails = await read<{ email: string; primary: boolean; verified: boolean }[]>(tokens.access_token, '/user/emails');
      const email = emails.find((e) => e.primary && e.verified)?.email;
      const teams = usesGroups(c) ? await read<{ slug: string; organization: { login: string } }[]>(tokens.access_token, '/user/teams?per_page=100') : [];
      const who: Identity = { realm: c.name, subject: String(user.id), username: user.login, groups: teams.map((t) => `${t.organization.login}/${t.slug}`) };
      const name = stringOf(user.name);
      return { ...who, ...(email ? { email } : {}), ...(name ? { name } : {}) };
    },
  };
}
