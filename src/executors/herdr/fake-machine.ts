// The fake HerdrClient's machine (fake-client.ts): the machine's fixed scripts (issues #410, #441, #542, #695), recorded,
// and refused while it cannot be reached.
import type { MachineShell } from '../../domain/ports.ts';
import type { HerdrClient } from './client.ts';
import type { FakeHerdrClient, FakeHerdrOptions } from './fake-options.ts';

export function fakeMachineShell(o: FakeHerdrOptions, fake: () => FakeHerdrClient, onMachine: (method: keyof HerdrClient, ...args: unknown[]) => void): MachineShell {
  return {
    async reap(jobId, scratch, keep, discard) {
      onMachine('reap', jobId, scratch);
      fake().reaps.push({ jobId, ...(scratch ? { scratch } : {}), ...(keep ? { keep } : {}), ...(discard ? { discard } : {}) });
      if (discard && o.discardMs) await new Promise((res) => setTimeout(res, o.discardMs));
      return { kept: discard ? [] : [...(o.reapKeeps ?? [])], ...(o.reapPushes?.length ? { pushed: [...o.reapPushes] } : {}) };
    },
    survey: async (roots) => (onMachine('survey', roots), o.survey ?? { scopes: [], processes: [], scratch: [] }),
    discover: async () => (onMachine('discover'), o.discovery ?? { path: [], bins: [], versions: {}, aws: [], kube: [], credentials: { env: [], files: [] } }),
    reach: async (url) => (onMachine('reach', url), o.unreached),
    async checkpoint(jobId, worktree, session) {
      onMachine('checkpoint', jobId, worktree, session);
      fake().checkpoints.push({ jobId, worktree, session });
      return o.checkpoint ?? { none: 'the fake machine takes no checkpoint' };
    },
    async keepCredential(jobId, dir, file, content, make) {
      onMachine('keepCredential', jobId, dir, file);
      fake().credentials.push({ jobId, dir, file, content, ...(make ? { make } : {}) });
    },
  };
}
