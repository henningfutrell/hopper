// The Solr search reads and writes, with its credentials (issue #2990, design.md "Search with a managed Solr").
// HOPPER_SOLR_URL names a standalone core or a collection on a SolrCloud cluster: the calls are the same on both. A managed
// Solr asks for basic auth: the username and password come from the runtime (HOPPER_SOLR_USERNAME and
// HOPPER_SOLR_PASSWORD, each also as the file NAME_FILE names, read again at each call so a rotated one counts), or from
// the URL's userinfo; never both. The URL the hopper logs, and names in an error, has no userinfo, and no error names the
// password. fetch refuses a URL with userinfo, so it is always taken out.
import type { RuntimeSecrets } from '../secrets/runtime.ts';

export const SOLR_USERNAME = 'HOPPER_SOLR_USERNAME';
export const SOLR_PASSWORD = 'HOPPER_SOLR_PASSWORD';

export interface SolrConnection {
  /** The core's or the collection's URL, with no userinfo and no trailing slash: the only form logged. */
  url: string;
  /** Whether the hopper sends basic auth. */
  auth: boolean;
  /** The Authorization header of a call, read now; undefined: none is sent. */
  authorization(): string | undefined;
}

const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;

/** The connection HOPPER_SOLR_URL names; throws, naming no secret, when its credentials are given twice or by half. */
export function solrConnection(raw: string, secrets: RuntimeSecrets): SolrConnection {
  const u = new URL(raw);
  const inUrl = u.username !== '' || u.password !== '';
  const user = inUrl ? decodeURIComponent(u.username) : '', password = inUrl ? decodeURIComponent(u.password) : '';
  u.username = ''; u.password = '';
  const url = u.toString().replace(/\/+$/, '');
  const fromEnv = (): { user?: string; password?: string } => ({ user: secrets(SOLR_USERNAME), password: secrets(SOLR_PASSWORD) });
  const first = fromEnv();
  if (inUrl) {
    if (first.user !== undefined || first.password !== undefined) throw new Error(`HOPPER_SOLR_URL has credentials and ${SOLR_USERNAME} or ${SOLR_PASSWORD} is set: set one`);
    if (!user) throw new Error('HOPPER_SOLR_URL has a password and no username');
    if (!password) throw new Error('HOPPER_SOLR_URL has a username and no password');
    const header = basic(user, password);
    return { url, auth: true, authorization: () => header };
  }
  if (first.user !== undefined && first.password === undefined) throw new Error(`${SOLR_USERNAME} is set with no ${SOLR_PASSWORD}`);
  if (first.password !== undefined && first.user === undefined) throw new Error(`${SOLR_PASSWORD} is set with no ${SOLR_USERNAME}`);
  if (first.user === undefined) return { url, auth: false, authorization: () => undefined };
  return {
    url, auth: true,
    authorization: () => {
      const now = fromEnv();
      return now.user !== undefined && now.password !== undefined ? basic(now.user, now.password) : undefined;
    },
  };
}

/** The start line: which Solr, with no userinfo, and whether basic auth is on. */
export const solrStartLine = (c: Pick<SolrConnection, 'url' | 'auth'>): string => `hopper: search: Solr at ${c.url}, basic auth ${c.auth ? 'on' : 'off'}`;
