// The settings of search's Solr (issues #945, #2990): the URL of its core or SolrCloud collection, and the basic-auth
// credentials of a managed Solr. Part of the daemon's settings (src/config.ts), kept here beside the adapter that uses
// them. The password is a credential the hopper is given: the variable, or the mounted file HOPPER_SOLR_PASSWORD_FILE
// names (src/secrets/runtime.ts, read by config.ts); the URL's userinfo is taken out of the URL, so it is never logged.
import { z } from 'zod';
import type { SolrCredentials } from './solr.ts';

export type { SolrCredentials };

export const SOLR_SETTINGS = {
  HOPPER_SOLR_URL: z.url({ protocol: /^https?$/, error: 'must be an http(s) URL: the Solr core or collection, http://solr:8983/solr/hopper' }).optional(),
  HOPPER_SOLR_USERNAME: z.string().min(1).max(256).regex(/^[^:]+$/, 'must hold no colon').optional(),
  HOPPER_SOLR_PASSWORD: z.string().min(1).max(1024).optional(),
};

export const SOLR_SETTING_HELP = {
  HOPPER_SOLR_URL: 'the Solr core or SolrCloud collection search keeps its index in (http://solr:8983/solr/hopper, the compose service `solr`). Its userinfo, if any, is the basic-auth credentials. Unset: no search',
  HOPPER_SOLR_USERNAME: 'the basic-auth user search signs in to Solr as, with HOPPER_SOLR_PASSWORD (a managed Solr). Unset: no credentials',
  HOPPER_SOLR_PASSWORD: 'that user\'s password; or HOPPER_SOLR_PASSWORD_FILE, a mounted secret file. Never logged',
};

type Parsed = { HOPPER_SOLR_URL?: string | undefined; HOPPER_SOLR_USERNAME?: string | undefined; HOPPER_SOLR_PASSWORD?: string | undefined };

/** What is wrong with the settings, and which variable to name; never a value. */
export function solrProblem(e: Parsed): { path: string; message: string } | undefined {
  const url = e.HOPPER_SOLR_URL !== undefined ? new URL(e.HOPPER_SOLR_URL) : undefined;
  const inUrl = url !== undefined && (url.username !== '' || url.password !== '');
  if (e.HOPPER_SOLR_PASSWORD !== undefined && e.HOPPER_SOLR_USERNAME === undefined) return { path: 'HOPPER_SOLR_USERNAME', message: 'must be set with HOPPER_SOLR_PASSWORD' };
  if (e.HOPPER_SOLR_USERNAME !== undefined && e.HOPPER_SOLR_PASSWORD === undefined) return { path: 'HOPPER_SOLR_PASSWORD', message: 'must be set with HOPPER_SOLR_USERNAME (or HOPPER_SOLR_PASSWORD_FILE)' };
  if (e.HOPPER_SOLR_USERNAME !== undefined && url === undefined) return { path: 'HOPPER_SOLR_URL', message: 'must be set with HOPPER_SOLR_USERNAME and HOPPER_SOLR_PASSWORD: the Solr they sign in to' };
  if (inUrl && (url.username === '' || url.password === '')) return { path: 'HOPPER_SOLR_URL', message: 'carries half its credentials: give user:password, or neither' };
  if (inUrl && e.HOPPER_SOLR_USERNAME !== undefined) return { path: 'HOPPER_SOLR_URL', message: 'carries credentials; set them there or in HOPPER_SOLR_USERNAME and HOPPER_SOLR_PASSWORD, not both' };
  return undefined;
}

/** The Solr URL without its userinfo, and the credentials: the variables', else the userinfo's (percent-decoded). */
export function solrSettings(url: string, username: string | undefined, password: string | undefined): { solrUrl: string; solrAuth?: SolrCredentials } {
  const u = new URL(url);
  const fromUrl = u.username !== '' ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : undefined;
  u.username = ''; u.password = '';
  const auth = username !== undefined && password !== undefined ? { username, password } : fromUrl;
  return { solrUrl: u.toString().replace(/\/+$/, ''), ...(auth ? { solrAuth: auth } : {}) };
}
