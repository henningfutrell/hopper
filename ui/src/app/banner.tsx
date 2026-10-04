// Read-only until logged in: say how, with the command ready to copy.
import { Copy, Lock } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { LOGIN_CMD } from '@/lib/api';
import { useHopper } from '@/store';

export function ReadOnlyBanner() {
  const authed = useHopper((s) => s.authed);
  if (authed) return null;
  const copy = () => navigator.clipboard?.writeText(LOGIN_CMD).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-xs text-muted-foreground">
      <Lock className="size-3.5" />Read-only. To act, run
      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground/90">{LOGIN_CMD}</code>
      <Button variant="ghost" size="icon-xs" aria-label="Copy command" onClick={copy}><Copy /></Button>
    </div>
  );
}
