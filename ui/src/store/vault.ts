// The vault in the store. The live stream (issue #583): a job asks the user for a credential — said once, as it comes; the
// request itself waits on Access requests until an admin gives one or declines. The vault's view (issue #897): one copy,
// read again after each vault event, for Vault, Access requests, and the counts of Needs you and the nav. A
// view that cannot be read is no count, and Access requests says why; the other pages keep the last view.
import { useEffect } from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { get, post, SessionRejected } from '@/lib/api';
import { rereadsVault } from '@/model/vault';
import type { DomainEvent, VaultView } from '@/model/wire';
import { useHopper } from './index';

export function announceCredentialAsked(e: DomainEvent): void {
  toast(`A job asks for a ${String(e.data.skill)} credential`, {
    description: 'Give it, or decline, on Access requests.', duration: 15_000,
    action: { label: 'Open', onClick: () => { location.hash = '#approvals/access-requests'; } },
  });
}

export const useVaultStore = create<{ view: VaultView | null; error: string | null; busy: boolean }>(() => ({ view: null, error: null, busy: false }));

// Issue #1019: each request whose answer is the view gets a number when it is sent, and the view keeps an answer only when
// no request sent after it was answered first. Ten approvals at once, or a read that started before a change, so never
// roll back what a later answer showed.
let sent = 0;
let shown = 0;
const keep = (n: number, view: VaultView): void => {
  if (n <= shown) return;
  shown = n;
  useVaultStore.setState({ view, error: null });
};

/** Keeps a view a request answered just now, as the newest. */
export const setVaultView = (view: VaultView): void => keep(++sent, view);

/** Sends one request whose answer is the vault's view, and keeps that answer unless a later request's came first. */
export async function viewAnswer(send: () => Promise<VaultView>): Promise<VaultView> {
  const n = ++sent;
  const view = await send();
  keep(n, view);
  return view;
}

let reading: Promise<void> | null = null;
let again = false;
/** Reads the view again. Asked while a read runs, it reads once more after that one, so the last change is read. */
export function loadVault(): Promise<void> {
  if (reading) { again = true; return reading; }
  const read = (): Promise<void> => viewAnswer(() => get<VaultView>('/api/vault').then((v) => {
    if (!Array.isArray(v.templates)) throw new Error('the answer is no vault view');
    return v;
  }))
    .then(() => undefined, (e: unknown) => useVaultStore.setState({ error: (e as Error).message }))
    .then(() => { if (!again) return; again = false; return read(); });
  reading = read().finally(() => { reading = null; });
  return reading;
}

/** The vault's view, read when first used and again after each vault or template event. */
export function useVault(): VaultView | null {
  const lastChange = useHopper((s) => s.events.find((e) => rereadsVault(e.type))?.id);
  const authed = useHopper((s) => s.authed);
  useEffect(() => { if (authed) void loadVault(); }, [lastChange, authed]);
  return useVaultStore((s) => s.view);
}

/**
 * Sends one vault edit (POST /ui/api/vault) and keeps the view it answers. A card's approval on Access requests goes
 * through store/access-approvals.ts instead, which marks nothing else busy (issues #1001, #1018).
 */
export async function sendVault(edit: unknown, done: string): Promise<boolean> {
  useVaultStore.setState({ busy: true });
  try {
    await viewAnswer(() => post<VaultView>('/ui/api/vault', edit));
    toast.success(done);
    return true;
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false });
    toast.error((e as Error).message);
    return false;
  } finally {
    useVaultStore.setState({ busy: false });
  }
}
