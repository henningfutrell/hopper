// An approved egress host is live before the approval ends (issue #2639 part 4, design.md "A template's egress hosts").
// The egress proxy's allowlist grew only when a box started, so a box that ran already — a job's sandbox box, a bastion —
// got 403 for a host a person had just approved, and the job's wait on the approval ended first. Here an approval that
// approves a new egress host first puts the template's hosts in the proxy, and is kept only once the proxy holds them.
import type { Vault } from './vault.ts';

/** Why an approval is not kept: the proxy did not take the hosts. */
const notLive = (name: string, why: string): string =>
  `template ${name} is not approved: its egress hosts are not live in the egress proxy (${why}). Approve it again once the proxy runs`;

/** `allow`: puts the hosts (`host:port`) in the egress proxy, and resolves once it holds them (`Sandboxes.allowEgress`). */
export function withLiveEgress(v: Vault, allow: (hosts: readonly string[]) => Promise<void>): Vault {
  return {
    ...v,
    async approveTemplate(name, by, job) {
      const t = v.view().templates.find((x) => x.name === name);
      if (t && t.pending.egress.length > 0) {
        const why = await allow(t.egress ?? []).then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : String(e)));
        if (why) return { ok: false, code: 'unavailable', error: notLive(name, why) };
      }
      return v.approveTemplate(name, by, job);
    },
  };
}
