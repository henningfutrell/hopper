// The vault in the store. The live stream (issue #583): a job asks the user for a credential — said once, as it comes; the
// request itself waits on Access requests until an admin gives one or declines. The vault's view (issue #897): one copy,
// read again after each vault event, for Settings → Vault, Access requests, and the counts of Needs you and the nav. A
// view that cannot be read is no count, and Access requests says why; the other pages keep the last view.
import { useEffect } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { get, post, SessionRejected } from '@/lib/api';
import type { DomainEvent, VaultView } from '@/model/wire';
import { useHopper } from './index';

export function announceCredentialAsked(e: DomainEvent): void {
  toast(`A job asks for a ${String(e.data.skill)} credential`, {
    description: 'Give it, or decline, on Access requests.', duration: 15_000,
    action: { label: 'Open', onClick: () => { location.hash = '#access-requests'; } },
  });
}

export const useVaultStore = create<{ view: VaultView | null; error: string | null; busy: boolean }>(() => ({ view: null, error: null, busy: false }));

export const setVaultView = (view: VaultView): void => useVaultStore.setState({ view, error: null });

let reading: Promise<void> | null = null;
/** Reads the view again; a read that runs already is the one every caller waits on. */
export function loadVault(): Promise<void> {
  reading ??= get<VaultView>('/api/vault')
    .then((v) => { if (!Array.isArray(v.templates)) throw new Error('the answer is no vault view'); setVaultView(v); })
    .catch((e: unknown) => useVaultStore.setState({ error: (e as Error).message }))
    .finally(() => { reading = null; });
  return reading;
}

/** The vault's view, read when first used and again after each vault event. */
export function useVault(): VaultView | null {
  const lastChange = useHopper((s) => s.events.find((e) => e.type.startsWith('vault.'))?.id);
  const authed = useHopper((s) => s.authed);
  useEffect(() => { if (authed) void loadVault(); }, [lastChange, authed]);
  return useVaultStore((s) => s.view);
}

/**
 * Sends one vault edit (POST /ui/api/vault) and keeps the view it answers. `quiet`: a card's own decision (issue #1001),
 * which marks nothing else busy, so the other cards stay clickable while it is pending.
 */
export async function sendVault(edit: unknown, done: string, o: { quiet?: boolean } = {}): Promise<boolean> {
  if (!o.quiet) useVaultStore.setState({ busy: true });
  try {
    setVaultView(await post<VaultView>('/ui/api/vault', edit));
    toast.success(done);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error((e as Error).message);
    return false;
  } finally {
    if (!o.quiet) useVaultStore.setState({ busy: false });
  }
}

/** A card's decision on Access requests (issue #1001): sent quietly, so no other card waits for it. */
export const sendDecision = (edit: unknown, done: string): Promise<boolean> => sendVault(edit, done, { quiet: true });
