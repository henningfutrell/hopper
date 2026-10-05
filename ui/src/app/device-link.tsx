// Log another device in (design.md "Reaching the UI across the LAN"): the current login code as a
// link per LAN name, each also drawn as a QR code for a phone's camera (issue #95). Each link works
// once; opening it on the other device logs that browser in. While the dialog is open it asks the
// daemon to keep the code it shows, and when that code is used or expired the daemon answers a
// fresh one: the QR always shows a code that still works.
import { Copy, MonitorSmartphone } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionRejected, deviceLinks } from '@/lib/api';
import { loginCodeFromHash } from '@/lib/login';
import { useHopper } from '@/store';

/** How often the open dialog asks whether its code is still live. */
const POLL_MS = 2000;

const codeOf = (links: string[]): string | undefined => {
  const first = links[0];
  return first === undefined ? undefined : (loginCodeFromHash(new URL(first).hash) ?? undefined);
};

export function DeviceLink({ pollMs = POLL_MS }: { pollMs?: number }) {
  const [links, setLinks] = useState<string[] | null>(null);
  const fail = (e: unknown) => {
    if (e instanceof SessionRejected) { useHopper.setState({ authed: false }); setLinks(null); }
    toast.error((e as Error).message);
  };
  const open = async () => {
    try { setLinks((await deviceLinks()).links); } catch (e) { fail(e); }
  };
  const code = links === null ? undefined : codeOf(links);
  useEffect(() => {
    if (code === undefined) return;
    let stop = false;
    const timer = setInterval(() => {
      deviceLinks(code).then((r) => {
        if (!stop && codeOf(r.links) !== code) setLinks(r.links);
      }, (e: unknown) => { if (!stop) { clearInterval(timer); fail(e); } });
    }, pollMs);
    return () => { stop = true; clearInterval(timer); };
  }, [code, pollMs]);
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
        <AlertDialogContent className="max-h-[90dvh] overflow-y-auto data-[size=default]:sm:max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Log in another device</AlertDialogTitle>
            <AlertDialogDescription>Scan a code with the other device, or open its link there. It works once; when it is used or expires, a new one appears here.</AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4">
            {links?.map((l) => {
              const host = new URL(l).host;
              return (
                <li key={l} data-device-link={l} className="flex min-w-0 flex-col items-center gap-2">
                  <QRCodeSVG value={l} size={144} marginSize={2} bgColor="#ffffff" fgColor="#000000" title={`QR code: ${host}`} className="rounded" />
                  <div className="flex w-full min-w-0 items-center justify-center gap-1">
                    <code className="min-w-0 truncate font-mono text-xs text-muted-foreground" title={l}>{host}</code>
                    <Button variant="ghost" size="icon-xs" aria-label="Copy link" onClick={() => copy(l)}><Copy /></Button>
                  </div>
                </li>
              );
            })}
          </ul>
          <AlertDialogFooter><AlertDialogCancel>Done</AlertDialogCancel></AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
