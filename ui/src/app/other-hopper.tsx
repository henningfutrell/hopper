// Another hopper at this address (issue #1295, lib/instance.ts): one notice in place of the whole page — no view, no
// banner, nothing that hopper said. A job's test hopper took the address of the user's hopper while that one was down;
// its banners must not read as the real hopper's. "This is my hopper now" is for a hopper set up again: the old one and
// its session are forgotten, and the page is read again.
import { ServerCrash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { clearToken } from '@/lib/api';
import { forgetKeptHopper, useOtherHopper } from '@/lib/instance';

export function HopperGate({ children, reload = () => location.reload() }: { children: React.ReactNode; reload?: () => void }) {
  const other = useOtherHopper();
  if (!other) return <>{children}</>;
  const mine = () => { forgetKeptHopper(); clearToken(); reload(); };
  return (
    <div className="flex min-h-dvh items-center justify-center p-4">
      <div data-other-hopper className="max-w-lg space-y-3 rounded-lg border border-warn/40 bg-warn/5 p-4 text-sm">
        <p className="flex items-center gap-2 font-medium"><ServerCrash className="size-4" />Another hopper answers at this address</p>
        <p>
          This page talks to the hopper <code className="font-mono text-xs">{other.expected}</code>. The answer came from{' '}
          {other.seen ? <>the hopper <code className="font-mono text-xs">{other.seen}</code></> : 'a server that is no hopper, or an older one'}.
          {' '}The page shows nothing of it and sends it nothing more, your session included.
        </p>
        <p className="text-muted-foreground">
          A test hopper that a job started can take this address while your hopper is down. Start your hopper again, then reload this page.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => location.reload()}>Reload</Button>
          <Button size="sm" variant="outline" onClick={mine}>This is my hopper now</Button>
        </div>
        <p className="text-xs text-muted-foreground">Use "This is my hopper now" only when you set up your hopper again: you then sign in again.</p>
      </div>
    </div>
  );
}
