// The dynamic vault in the live stream (issue #583): a job asks the user for a credential. Said once, as it comes; the
// request itself waits on Settings → Vault until an admin gives one or declines.
import { toast } from 'sonner';
import type { DomainEvent } from '@/model/wire';

export function announceCredentialAsked(e: DomainEvent): void {
  toast(`A job asks for a ${String(e.data.skill)} credential`, {
    description: 'Give it, or decline, on Settings → Vault.', duration: 15_000,
    action: { label: 'Open', onClick: () => { location.hash = '#settings/vault'; } },
  });
}
