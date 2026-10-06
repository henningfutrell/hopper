// The ldap realm (design.md "Sign-in: realms", issue #185): a directory (OpenLDAP, Active Directory,
// FreeIPA, …) through ldapts. Search, then bind: bind as `bindDn` (or anonymously), find the one entry
// `userFilter` names under `userBase`, then bind as that entry with the password given. Groups are the
// entry's `attributes.groups` values, plus a group search when one is set. Every value from the form is
// escaped into the filter. A fresh connection per sign-in, closed after it.
import { Client, Filter, InvalidCredentialsError } from 'ldapts';
import type { Identity } from '../domain/types.ts';
import type { LdapRealmConfig } from './config.ts';
import type { FormRealm } from './realm.ts';
import { roleFor } from './roles.ts';

const TIMEOUT_MS = 10_000;

/** An attribute's values as strings (ldapts gives a string, a list of them, or Buffers). */
function values(v: unknown): string[] {
  const all = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return all.map((x) => (Buffer.isBuffer(x) ? x.toString('utf8') : String(x))).filter((x) => x !== '');
}
const first = (v: unknown): string | undefined => values(v)[0];

export function createLdapRealm(c: LdapRealmConfig): FormRealm {
  const attrs = [c.attributes.username, c.attributes.email, c.attributes.name, c.attributes.groups, ...(c.attributes.subject ? [c.attributes.subject] : [])];
  const open = async (): Promise<Client> => {
    const client = new Client({ url: c.url, timeout: TIMEOUT_MS, connectTimeout: TIMEOUT_MS });
    if (c.startTls) await client.startTLS({ servername: new URL(c.url).hostname });
    return client;
  };
  return {
    name: c.name, label: c.label, type: 'ldap',
    async check(username, password) {
      // An empty password is an unauthenticated bind, which a directory accepts as anonymous.
      if (username === '' || password === '') return { ok: false };
      let client: Client | undefined;
      try {
        client = await open();
        if (c.bindDn) await client.bind(c.bindDn, c.bindPassword ?? '');
        const filter = c.userFilter.replaceAll('{username}', Filter.escape(username));
        const { searchEntries } = await client.search(c.userBase, { scope: 'sub', filter, attributes: attrs, sizeLimit: 2 });
        if (searchEntries.length !== 1) return { ok: false };
        const entry = searchEntries[0]!;
        try {
          await client.bind(entry.dn, password);
        } catch (e) {
          if (e instanceof InvalidCredentialsError) return { ok: false };
          throw e;
        }
        const groups = values(entry[c.attributes.groups]);
        if (c.groupSearch) {
          // Bound as the user now: the user's own read rights decide what the group search sees, unless a bind DN is set.
          if (c.bindDn) await client.bind(c.bindDn, c.bindPassword ?? '');
          const g = await client.search(c.groupSearch.base, { scope: 'sub', filter: c.groupSearch.filter.replaceAll('{dn}', Filter.escape(entry.dn)), attributes: [c.groupSearch.name] });
          groups.push(...g.searchEntries.flatMap((x) => values(x[c.groupSearch!.name])));
        }
        const email = first(entry[c.attributes.email]);
        const name = first(entry[c.attributes.name]);
        const who: Identity = {
          realm: c.name, subject: (c.attributes.subject ? first(entry[c.attributes.subject]) : undefined) ?? entry.dn,
          username: first(entry[c.attributes.username]) ?? username, groups,
          ...(email ? { email } : {}), ...(name ? { name } : {}),
        };
        return { ok: true, who, role: roleFor(who, c.roles) };
      } catch (e) {
        return { ok: false, error: `${c.label}: ${(e as Error).message}` };
      } finally {
        await client?.unbind().catch(() => {});
      }
    },
  };
}
