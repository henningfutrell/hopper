// The Solr credentials in the hopper's vault (issue #2990, design.md "Search with a managed Solr"): when the runtime gives
// none (HOPPER_SOLR_USERNAME / HOPPER_SOLR_PASSWORD or the userinfo of HOPPER_SOLR_URL), the hopper's admin can keep them
// as one system secret of the instance's vault, `solr-credentials` — Settings → Search, POST /ui/api/solr-credentials,
// `hopper solr-credentials`. A set is checked once against Solr (one count on the core or the collection) before it is
// kept; a pair Solr refuses is not kept. The runtime's credentials win: a set is refused while they are given. The pair is
// kept as JSON, with no last 4 characters (its end is the password's). No view, answer, event, log or error holds the
// username or the password.
import type { SolrCredentialsView } from '../domain/search.ts';
import type { SystemSecretName } from '../domain/vault.ts';
import { maskSecret } from '../secrets/mask.ts';
import { SecretUnreadable } from '../secrets/sealer.ts';
import type { SystemSecrets } from '../vault/system.ts';
import { basicAuthorization, type SolrConnection, type SolrCredentials } from './solr-connection.ts';
import { createSolrIndex } from './solr.ts';

export const SOLR_CREDENTIALS: SystemSecretName = 'solr-credentials';

/** The one check of a pair against Solr: `authorization` is the header to send. */
export type SolrCheck = (authorization: string) => Promise<{ ok: true } | { ok: false; why: string }>;

/** The check at the Solr `connection` names: one count on its core or collection with the pair; Solr's refusal, else why not reached. */
export const solrCheck = (connection: Pick<SolrConnection, 'url'> | undefined, instance: string): SolrCheck => async (authorization) => {
  if (!connection) return { ok: false, why: 'search is not configured' };
  try {
    await createSolrIndex({ url: connection.url, authorization: () => authorization }).count({ instance, user: '-' });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: (e as Error).message };
  }
};

export type SolrCredentialsEdit = { action: 'set'; username: string; password: string } | { action: 'remove' };
export type SolrCredentialsResult = { ok: true; view: SolrCredentialsView } | { ok: false; code: 'invalid' | 'conflict' | 'not_found' | 'unavailable'; error: string };

export interface SolrCredentialsAdmin {
  view(): SolrCredentialsView;
  change(edit: SolrCredentialsEdit, by: string): Promise<SolrCredentialsResult>;
}

/** The pair the vault keeps, opened now; undefined when none is kept. Throws SecretUnreadable when it cannot be opened. */
export function solrCredentialsReader(secrets: Pick<SystemSecrets, 'open'>): () => SolrCredentials | undefined {
  return () => {
    const raw = secrets.open(SOLR_CREDENTIALS, 'search');
    if (raw === undefined) return undefined;
    const v = JSON.parse(raw) as Partial<SolrCredentials>;
    if (typeof v.username !== 'string' || typeof v.password !== 'string') throw new SecretUnreadable('the solr-credentials system secret holds no username and password');
    return { username: v.username, password: v.password };
  };
}

export function createSolrCredentials(o: {
  secrets: Pick<SystemSecrets, 'open' | 'meta' | 'keep' | 'drop' | 'problem'>;
  /** The connection HOPPER_SOLR_URL names; absent: search is not configured. */
  connection: Pick<SolrConnection, 'url' | 'source'> | undefined;
  check: SolrCheck;
  /** Told after a set or a remove, so search tries Solr again at once. */
  changed?: () => void;
}): SolrCredentialsAdmin {
  const fail = (code: 'invalid' | 'conflict' | 'not_found' | 'unavailable', error: string): SolrCredentialsResult => ({ ok: false, code, error });

  function view(): SolrCredentialsView {
    const meta = o.secrets.meta(SOLR_CREDENTIALS);
    let problem = o.secrets.problem();
    if (!problem && meta) {
      try { o.secrets.open(SOLR_CREDENTIALS, 'the Solr credentials view'); } catch (e) { if (e instanceof SecretUnreadable) problem = e.message; else throw e; }
    }
    return {
      configured: o.connection !== undefined, ...(o.connection ? { url: o.connection.url } : {}),
      source: o.connection?.source() ?? 'none',
      kept: meta ? { set: true, setBy: meta.setBy, setAt: meta.setAt } : { set: false },
      ...(problem ? { problem } : {}),
    };
  }

  async function set(username: string, password: string, by: string): Promise<SolrCredentialsResult> {
    if (!o.connection) return fail('conflict', 'search is not configured: set HOPPER_SOLR_URL first');
    const from = o.connection.source();
    if (from === 'url' || from === 'runtime') return fail('conflict', `the ${from === 'url' ? 'userinfo of HOPPER_SOLR_URL gives' : 'runtime gives HOPPER_SOLR_USERNAME and HOPPER_SOLR_PASSWORD, which give'} the Solr credentials, and they win: change them there`);
    const user = username.trim();
    if (!user || user.includes(':')) return fail('invalid', 'the username must not be empty and must not hold a colon');
    if (!password) return fail('invalid', 'the password is empty');
    const cannot = o.secrets.problem();
    if (cannot) return fail('unavailable', cannot);
    const checked = await o.check(basicAuthorization(user, password));
    if (!checked.ok) return fail('invalid', `the Solr credentials were not saved: the check against Solr failed: ${maskSecret(checked.why, password, 'password')}`);
    const kept = o.secrets.keep(SOLR_CREDENTIALS, JSON.stringify({ username: user, password }), by, { noLast4: true });
    if (!kept.ok) return fail(kept.code === 'forbidden' ? 'unavailable' : kept.code, kept.error);
    o.changed?.();
    return { ok: true, view: view() };
  }

  return {
    view,
    async change(edit, by) {
      if (edit.action === 'set') return set(edit.username, edit.password, by);
      if (!o.secrets.drop(SOLR_CREDENTIALS, by)) return fail('not_found', 'no Solr credentials are kept in the vault');
      o.changed?.();
      return { ok: true, view: view() };
    },
  };
}
