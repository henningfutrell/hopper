// The vault in a container of its own, as the hopper reaches it (issue #586, design.md "The vault in a container of its
// own"). The vault container holds the vault's key: setting or removing a secret, delivering one, and whether the vault
// can be used now are each a POST to HOPPER_VAULT_URL on the compose network, with the preshared key HOPPER_VAULT_KEY
// (read at each call, so a rotated file is used at once). The secrets' metadata and the templates — with their approvals,
// which are access's (issue #584) — are read and changed here, by a vault service that holds no key; so is a secret kept in
// a vault backend (issue #585), which the hopper runs and the vault container does not know. The hopper keeps the
// event log, so the events the vault container answers are appended here, where webhooks and the UI see them. A vault
// container that cannot be reached, or that refuses the key, is said so: its status is the problem, a set or a removal
// is unavailable, an ask refused — nothing else in the hopper waits on it.
import type { UserStore } from '../domain/ports.ts';
import type { NewEvent } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import type { ClientTarget, Vault, VaultResult, VaultService } from './service.ts';
import { VAULT_KEY_VARIABLE, VAULT_OP_PATH, type VaultOp } from './wire.ts';

const TIMEOUT_MS = 10_000;

export function remoteVault(o: {
  url: string;
  secret: RuntimeSecrets;
  user: string;
  store: Pick<UserStore, 'events'>;
  /** The vault service for the templates and the secrets' metadata: built with no key. */
  local: VaultService;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
}): Omit<Vault, 'need' | 'give' | 'decline'> {
  /** The vault container's answer, or why there is none. */
  async function call<T>(op: VaultOp, body: Record<string, unknown>): Promise<{ result: T } | { problem: string }> {
    const key = o.secret(VAULT_KEY_VARIABLE);
    if (!key) return { problem: `the vault at ${o.url} is not reachable: ${VAULT_KEY_VARIABLE} is not set` };
    let res: Response;
    try {
      res = await fetch(new URL(VAULT_OP_PATH + op, o.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user: o.user, ...body }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const cause = (e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message;
      return { problem: `the vault at ${o.url} is not reachable (${cause})` };
    }
    if (res.status === 401) return { problem: `the vault at ${o.url} refused the hopper: ${VAULT_KEY_VARIABLE} is not the vault's` };
    if (!res.ok) return { problem: `the vault at ${o.url} answered ${res.status}: ${await res.text().catch(() => '')}`.trim() };
    const answer = await res.json() as { result: T; events: NewEvent[] };
    for (const e of answer.events) o.store.events.append(e);
    return { result: answer.result };
  }

  const edit = async (op: VaultOp, body: Record<string, unknown>): Promise<VaultResult> => {
    const r = await call<VaultResult>(op, body);
    return 'problem' in r ? { ok: false, code: 'unavailable', error: r.problem } : r.result;
  };

  return {
    view: () => {
      const { problem: _noKeyHere, ...view } = o.local.view();
      return view;
    },
    async status() {
      const r = await call<string | null>('status', {});
      return 'problem' in r ? r.problem : r.result ?? undefined;
    },
    set: async (s, by) => ('value' in s
      ? edit('set', { secret: { name: s.name, value: s.value, ...(s.scope !== undefined ? { scope: s.scope } : {}) }, by })
      : o.local.set(s, by)),
    remove: (name, by) => edit('remove', { name, by }),
    async deliver(ask, machineKey) {
      if (o.local.view().secrets.find((s) => s.name === ask.name)?.backend) return o.local.deliver(ask, machineKey);
      // What only the hopper knows, said to the vault: the machine whose link signed the ask, and whether the job's
      // token is one this user's link key gives. The vault decides the rest.
      const machine = o.targets().find((m) => m.key === machineKey);
      const parts = parseProxyToken(ask.token);
      const r = await call<{ value: string } | { refused: string }>('deliver', { ask, ...(machine ? { machine } : {}), holds: parts !== undefined && o.holds(parts) });
      if (!('problem' in r)) return r.result;
      o.store.events.append({
        type: 'vault.refused', ...(machine ? { machineId: machine.name } : {}),
        data: { name: ask.name, machine: machine?.name ?? 'a machine that is gone', ...(machine?.template ? { template: machine.template } : {}), reason: r.problem },
      });
      return { refused: r.problem };
    },
    saveTemplate: (t, by) => o.local.saveTemplate(t, by),
    removeTemplate: (name, by) => o.local.removeTemplate(name, by),
    approveTemplate: (name, by) => o.local.approveTemplate(name, by),
    approveProfile: (name, profile, by) => o.local.approveProfile(name, profile, by),
    scopeOf: (machine) => o.local.scopeOf(machine),
    templateScopes: () => o.local.templateScopes(),
  };
}
