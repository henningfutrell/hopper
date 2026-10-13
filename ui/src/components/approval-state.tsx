// A card's own approval on Access requests (issue #1018): its checkbox for Approve selected, and what became of its
// approval — waiting for the daemon, approved, or failed with why.
import { Check, Loader2 } from 'lucide-react';
import type { ItemApproval } from '@/store/access-approvals';

export function SelectBox({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled: boolean; onChange: (on: boolean) => void }) {
  return (
    <input type="checkbox" data-slot="select" className="size-4 accent-primary" aria-label={`Select ${label}`}
      checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
  );
}

export function ApprovalState({ approval }: { approval: ItemApproval | undefined }) {
  if (!approval) return null;
  if (approval.state === 'pending') return <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />Approving…</span>;
  if (approval.state === 'approved') return <span data-slot="approved" className="inline-flex items-center gap-1 text-xs text-ok"><Check className="size-3" />Approved</span>;
  return <span role="alert" className="text-xs text-bad break-words">Not approved: {approval.error}</span>;
}
