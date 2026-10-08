// A button that runs one send action (issue #378) — Send test event on a notifier or a webhook
// subscription, Send open questions on a notifier — and shows what the receiver answered.
import type { LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { post, SessionRejected } from '@/lib/api';
import type { NotifierActionResult } from '@/model/wire';
import { useHopper } from '@/store';

export function SendAction({ label, icon: Icon, path, body, disabled }: {
  label: string; icon: LucideIcon; path: string; body: Record<string, unknown>; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const r = await post<NotifierActionResult>(path, body);
      (r.ok ? toast.success : toast.error)(`${label}: ${r.detail}`);
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void run()}><Icon />{label}</Button>;
}
