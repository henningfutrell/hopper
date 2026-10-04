// Log another device in (design.md "Reaching the UI across the LAN"): the current login code as a
// link per LAN name. Each link works once; opening it on the other device logs that browser in.
import { Copy, MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionRejected, deviceLinks } from '@/lib/api';
import { useHopper } from '@/store';

export function DeviceLink() {
  const [links, setLinks] = useState<string[] | null>(null);
  const open = async () => {
    try { setLinks((await deviceLinks()).links); } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    }
  };
  const copy = (l: string) => navigator.clipboard?.writeText(l).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'));
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Log in another device" onClick={() => void open()}><MonitorSmartphone /></Button>
        </TooltipTrigger>
        <TooltipContent>Log in another device</TooltipContent>
      </Tooltip>
      <AlertDialog open={links !== null} onOpenChange={(o) => { if (!o) setLinks(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Log in another device</AlertDialogTitle>
            <AlertDialogDescription>Open one link on the other device. It works once; the first use logs that browser in.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-2">
            {links?.map((l) => (
              <li key={l} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{l}</code>
                <Button variant="outline" size="icon-xs" aria-label="Copy link" onClick={() => copy(l)}><Copy /></Button>
              </li>
            ))}
          </ul>
          <AlertDialogFooter><AlertDialogCancel>Done</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
