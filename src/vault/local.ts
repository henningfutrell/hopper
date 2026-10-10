// The vault in the hopper's own process (issue #586): the vault service as the hopper's parts reach it, every call
// answered here. Its counterpart, the vault in a container of its own, is remote.ts.
import type { Vault, VaultService } from './service.ts';

/** The vault in the hopper's own process. */
export const localVault = (v: VaultService): Omit<Vault, 'need' | 'give' | 'decline'> => ({
  view: () => v.view(),
  status: async () => v.view().problem,
  set: async (s, by) => v.set(s, by),
  remove: async (name, by) => v.remove(name, by),
  deliver: (ask, key) => v.deliver(ask, key),
  mint: (ask, key) => v.mint(ask, key),
  saveTemplate: (t, by) => v.saveTemplate(t, by),
  removeTemplate: (name, by) => v.removeTemplate(name, by),
  approveTemplate: (name, by) => v.approveTemplate(name, by),
  approveProfile: (name, profile, by) => v.approveProfile(name, profile, by),
  scopeOf: (machine) => v.scopeOf(machine),
  boxes: () => v.boxes(),
  templateScopes: () => v.templateScopes(),
});
