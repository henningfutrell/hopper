// A user's vault with the shared secrets (issue #718, design.md "Shared secrets"): its view lists them, never a value;
// the hopper's admin sets and removes them through it; and a job's ask for one (`shared/<name>`) is answered here, in
// the hopper, wherever the user's own vault runs — a shared secret is sealed under the master key, never in a vault
// container. The ask passes the same checks as any delivery (box.ts), then the box's template must give it (its
// approved scope), then Access must allow the job's user. Every outcome is an event; never with the value.
import type { UserStore } from '../domain/ports.ts';
import { isSharedSecret } from '../domain/vault.ts';
import type { ProxyTokenParts } from '../github-proxy/token.ts';
import { boxAsk, type ClientTarget } from './box.ts';
import { deliveredNames } from './delivered.ts';
import type { SharedSecrets } from './shared.ts';
import type { Vault } from './vault.ts';

export function withSharedSecrets(v: Vault, o: {
  shared: SharedSecrets;
  userId: string;
  store: Pick<UserStore, 'events' | 'jobs'>;
  targets: () => ClientTarget[];
  holds: (parts: ProxyTokenParts) => boolean;
}): Vault {
  const { events } = o.store;

  async function deliver(ask: { name: string; token: string }, machineKey: string): Promise<{ value: string } | { refused: string }> {
    const box = boxAsk({ targets: o.targets, holds: o.holds, job: (id) => o.store.jobs.get(id), holdsTemplate: (t) => v.view().templates.some((x) => x.name === t) }, ask.token, machineKey);
    const { machine: m, job } = box;
    const refuse = (reason: string): { refused: string } => {
      events.append({
        type: 'vault.refused', ...(job ? { jobId: job.id } : {}), ...(m ? { machineId: m.name } : {}),
        data: { name: ask.name, machine: m?.name ?? 'a machine that is gone', ...(m?.template ? { template: m.template } : {}), ...(job ? { job: job.id } : {}), reason },
      });
      return { refused: reason };
    };
    if ('refused' in box) return refuse(box.refused);
    if (!v.scopeOf(box.machine.name).secrets.includes(ask.name)) return refuse(`${box.machine.template} is not approved for ${ask.name}: a person adds it to the template and approves it`);
    const r = await o.shared.read(ask.name, o.userId);
    if ('refused' in r) return refuse(r.refused);
    events.append({ type: 'vault.delivered', jobId: box.job.id, machineId: box.machine.name, data: { name: ask.name, template: box.machine.template, machine: box.machine.name, job: box.job.id } });
    return { value: r.value };
  }

  return {
    ...v,
    view: () => ({ ...v.view(), shared: o.shared.list() }),
    deliver: (ask, machineKey) => (isSharedSecret(ask.name) ? deliver(ask, machineKey) : v.deliver(ask, machineKey)),
    // The shared secrets delivered to a job too (issue #1957): its checkpoint is scrubbed of them.
    async deliveredTo(jobId) {
      const shared = await Promise.all(deliveredNames(events, jobId).filter(isSharedSecret).map((name) => o.shared.read(name, o.userId).catch(() => ({ refused: '' }))));
      return [...new Set([...await v.deliveredTo(jobId), ...shared.flatMap((r) => ('value' in r && r.value ? [r.value] : []))])];
    },
    shared: { set: (s, who) => o.shared.set(s, who), remove: (name, who) => o.shared.remove(name, who) },
  };
}
