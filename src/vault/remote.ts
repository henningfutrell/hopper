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
import type { MintedFrom, MintFrom, MintRefused } from './mint.ts';
import type { UnbindFrom } from './bindings.ts';
import { parseProxyToken, type ProxyTokenParts } from '../github-proxy/token.ts';
import type { RuntimeSecrets } from '../secrets/runtime.ts';
import type { ClientTarget, VaultResult, VaultService } from './service.ts';
import type { Vault } from './vault.ts';
import type { AgentCredentialAnswer } from './agent-credential.ts';
import { refusedRead, type DatabaseReadAnswer, type DatabaseReadFrom } from './database-reads.ts';
import { VAULT_KEY_VARIABLE, VAULT_OP_PATH, type VaultOp } from './wire.ts';
import { CONNECT_TIMEOUT_MS, READ_STATEMENT_TIMEOUT_MS } from '../domain/database-read.ts';

const TIMEOUT_MS = 10_000;
/** A database read (issue #2231) waits for the mint, the read and the drop: each connect and the statement's own timeout. */
const READ_TIMEOUT_MS = 4 * CONNECT_TIMEOUT_MS + READ_STATEMENT_TIMEOUT_MS;

export function remoteVault(o: {
  url: string;
  secret: RuntimeSecrets;
  user: string;
  store: Pick<UserStore, 'events'>;
  /** The vault service for the templates and the secrets' metadata: built with no key. */
  local: VaultService;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
}): Omit<Vault, 'need' | 'give' | 'decline' | 'holdCheck'> {
  /** The vault container's answer, or why there is none. */
  async function call<T>(op: VaultOp, body: Record<string, unknown>, timeoutMs = TIMEOUT_MS): Promise<{ result: T } | { problem: string }> {
    const key = o.secret(VAULT_KEY_VARIABLE);
    if (!key) return { problem: `the vault at ${o.url} is not reachable: ${VAULT_KEY_VARIABLE} is not set` };
    let res: Response;
    try {
      res = await fetch(new URL(VAULT_OP_PATH + op, o.url), {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ user: o.user, ...body }),
        signal: AbortSignal.timeout(timeoutMs),
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

  // Every check and Access's decision run here, in the hopper (issue #580); only the mint itself crosses, to the vault
  // that holds the minting credential. One kept in a vault backend is minted here, which runs the backends.
  const mintFrom: MintFrom = async (from, target, jobId, identify) => {
    const names = typeof from === 'string' ? [from] : from.credentials.map((c) => c.name);
    if (o.local.view().secrets.some((s) => names.includes(s.name) && s.backend)) return o.local.mintFrom(from, target, jobId, identify);
    const source = typeof from === 'string' ? { credential: from } : { discover: from };
    const r = await call<MintedFrom | MintRefused>('mint', { ...source, target, jobId, ...(identify ? { identify } : {}) });
    return 'problem' in r ? { refused: r.problem } : r.result;
  };

  // An unbind (issue #1371) crosses the same way: the vault that holds the minting credential deletes the Secret.
  const unbindFrom: UnbindFrom = async (b) => {
    if (o.local.view().secrets.find((s) => s.name === b.credential)?.backend) return o.local.unbindFrom(b);
    const r = await call<{ ok: true } | { refused: string }>('unbind', { binding: b });
    return 'problem' in r ? { refused: r.problem } : r.result;
  };

  // A database read (issue #2231) crosses the same way, after Access allowed it here: the vault that holds the database's
  // minting credential mints the database read role, runs the SELECT and drops the role. One kept in a vault backend is read here.
  const readFrom: DatabaseReadFrom = async (r) => {
    if (o.local.view().secrets.some((s) => s.mints?.kind === 'database' && s.mints.name === r.asset.name && s.backend)) return o.local.readAllowed(r);
    const answer = await call<DatabaseReadAnswer>('database-read', { read: r }, READ_TIMEOUT_MS);
    return 'problem' in answer ? refusedRead(o.store.events, r, { status: 503, no: answer.problem }, r.decision) : answer.result;
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
      ? edit('set', { secret: { name: s.name, value: s.value, ...(s.scope !== undefined ? { scope: s.scope } : {}), ...(s.mints !== undefined ? { mints: s.mints } : {}) }, by })
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
    // A step's secret (issue #731): opened in the vault container; one kept in a vault backend is read here.
    async forStep(ask) {
      if (o.local.view().secrets.find((s) => s.name === ask.name)?.backend) return o.local.forStep(ask);
      const r = await call<{ value: string } | { refused: string }>('step-deliver', { ask });
      if (!('problem' in r)) return r.result;
      o.store.events.append({ type: 'vault.step_refused', jobId: ask.job, data: { name: ask.name, host: ask.host, job: ask.job, reason: r.problem } });
      return { refused: r.problem };
    },
    mint: (ask, machineKey) => o.local.mint(ask, machineKey, mintFrom),
    testMint: (asset, by) => o.local.testMint(asset, by, mintFrom), mintForDiscovery: (asset) => o.local.mintForDiscovery(asset, mintFrom),
    mintForCheck: (ask) => o.local.mintForCheck(ask, mintFrom),
    mintForNeedStep: (ask) => o.local.mintForNeedStep(ask, mintFrom),
    readDatabase: (ask) => o.local.readDatabase(ask, readFrom),
    releaseMints: (box) => o.local.releaseMints(box, unbindFrom),
    // The database read roles a read left (issue #2231) are swept where their minting credentials are opened: in the
    // vault container; one kept in a vault backend here. A vault container out of reach sweeps at the next pass.
    async reconcileMints() {
      await o.local.reconcileMints(unbindFrom);
      await call('database-sweep', {});
    },
    saveTemplate: (t, by) => o.local.saveTemplate(t, by),
    removeTemplate: (name, by) => o.local.removeTemplate(name, by),
    approveTemplate: (name, by, job) => o.local.approveTemplate(name, by, job),
    revokeTemplate: (name, by) => o.local.revokeTemplate(name, by),
    approveProfile: (name, profile, by) => o.local.approveProfile(name, profile, by),
    scopeOf: (machine) => o.local.scopeOf(machine),
    boxRadius: (machine) => o.local.boxRadius(machine),
    boxes: () => o.local.boxes(),
    templateScopes: () => o.local.templateScopes(),
    recordCheck: (name, check) => o.local.recordCheck(name, check), checkTemplate: (name, by) => o.local.checkTemplate(name, by),
    // A launch's agent credential (issue #708, part 10): opened in the vault container, which holds the key; one kept in a
    // vault backend is read here, which runs the backends.
    async agentCredential(ask) {
      const name = o.local.view().templates.find((t) => t.name === ask.template)?.agentCredential;
      if (name !== undefined && o.local.view().secrets.find((s) => s.name === name)?.backend) return o.local.agentCredential(ask);
      const r = await call<AgentCredentialAnswer>('agent-credential', { ask });
      return 'problem' in r ? { refused: r.problem } : r.result;
    },
    // The values delivered to a job (issue #1957): those kept in a vault backend read here, the rest opened in the vault
    // container. A vault container that cannot be reached answers none of its own: the checkpoint is scrubbed by pattern.
    async deliveredTo(jobId) {
      const here = await o.local.deliveredTo(jobId);
      const r = await call<string[]>('delivered-to', { jobId });
      return [...new Set([...here, ...('problem' in r ? [] : r.result)])];
    },
    // A job pod's agent credential (issue #1287): the same split.
    async podCredential(ask) {
      if (o.local.view().secrets.find((s) => s.name === ask.name)?.backend) return o.local.podCredential(ask);
      const r = await call<AgentCredentialAnswer>('pod-credential', { ask });
      return 'problem' in r ? { refused: r.problem } : r.result;
    },
  };
}
