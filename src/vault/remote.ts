// The vault in a container of its own, as the hopper reaches it (issue #586, design.md "The vault in a container of its
// own"): each edit and each ask is a POST to HOPPER_VAULT_URL on the compose network, with the preshared key
// HOPPER_VAULT_KEY (read at each call, so a rotated file is used at once). The vault decides and seals; the hopper keeps
// the event log, so the events the vault answers are appended here, where webhooks and the UI see them. A vault that
// cannot be reached, or that refuses the key, is said so: the view carries it as its problem, an edit is unavailable,
// an ask refused — nothing else in the hopper waits on it.
import type { UserStore } from '../domain/ports.ts';
import type { NewEvent } from '../domain/types.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import type { VaultView } from '../domain/vault.ts';
import type { ClientTarget, Vault, VaultResult } from './service.ts';
import { VAULT_KEY_VARIABLE, VAULT_OP_PATH, type VaultOp } from './wire.ts';

const TIMEOUT_MS = 10_000;

export function remoteVault(o: {
  url: string;
  secret: RuntimeSecrets;
  user: string;
  store: Pick<UserStore, 'events'>;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
}): Vault {
  /** The vault's answer, or why there is none. */
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
      return { problem: `the vault at ${o.url} is not reachable (${(e as Error).cause instanceof Error ? ((e as Error).cause as Error).message : (e as Error).message})` };
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
    async view(): Promise<VaultView> {
      const r = await call<VaultView>('view', {});
      return 'problem' in r ? { secrets: [], templates: [], problem: r.problem } : r.result;
    },
    set: ({ name, scope, value }, by) => edit('set', { secret: { name, value, ...(scope !== undefined ? { scope } : {}) }, by }),
    remove: (name, by) => edit('remove', { name, by }),
    saveTemplate: ({ name, image, secrets }, by) => edit('save-template', { template: { name, image, secrets }, by }),
    removeTemplate: (name, by) => edit('remove-template', { name, by }),
    approveTemplate: (name, by) => edit('approve-template', { name, by }),
    async deliver(ask, machineKey) {
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
  };
}
