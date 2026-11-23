// Settings → Search (issue #2990), pure: which Solr search uses, where the credentials it sends come from, and whether the
// hopper's vault keeps a pair. Never the username or the password: the view holds neither.
import type { SolrCredentialsView } from './wire.ts';

const when = (iso: string): string => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

/** Where the credentials come from, in words. */
export function solrSourceLine(v: Pick<SolrCredentialsView, 'configured' | 'source'>): string {
  if (!v.configured) return 'Search is off: the hopper has no Solr (HOPPER_SOLR_URL is not set).';
  if (v.source === 'url') return 'The Solr URL given at launch holds the credentials. They win over the vault\'s: change them where the hopper is launched.';
  if (v.source === 'runtime') return 'The credentials are given at launch (HOPPER_SOLR_USERNAME and HOPPER_SOLR_PASSWORD). They win over the vault\'s: change them where the hopper is launched.';
  if (v.source === 'vault') return 'The hopper sends the credentials kept in its vault.';
  return 'The hopper sends no credentials to Solr.';
}

/** The vault's pair: set, who and when; or none. */
export function solrKeptLine(kept: SolrCredentialsView['kept']): string {
  return kept.set ? `Kept in the vault — ${when(kept.setAt)} by ${kept.setBy} · sealed` : 'None kept in the vault.';
}

/** Whether a person can set a pair here: search is on, and the launch gives none. */
export const solrMaySet = (v: Pick<SolrCredentialsView, 'configured' | 'source' | 'problem'>): boolean =>
  v.configured && (v.source === 'vault' || v.source === 'none') && v.problem === undefined;
