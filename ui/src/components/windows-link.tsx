// The Windows link (issue #712): a WSL machine whose client found that Windows does not reach the hopper. The fix for its
// networking mode, on its Machines card; and one banner over every view that names each such machine, with the same fix,
// and the keep-alive loop on Windows when it reported a broken link.
// Not dismissable: it ends when the client finds that Windows reaches the hopper again.
import { MonitorX } from 'lucide-react';
import { brokenWindowsLinks, windowsLinkFix, windowsLinkText } from '@/model/windows-link';
import type { WindowsLink } from '@/model/wire';
import { useHopper } from '@/store';

/** The fix, one step per line. */
export function WindowsLinkFix({ link }: { link: WindowsLink }) {
  return (
    <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
      {windowsLinkFix(link).map((step) => <li key={step}>{step}</li>)}
    </ol>
  );
}

/** On a machine card: the link is broken, and the fix. */
export function WindowsLinkProblem({ link }: { link: WindowsLink }) {
  if (link.ok) return null;
  return (
    <div role="alert" data-windows-link="broken" className="grid gap-1.5 text-sm">
      <p className="text-warn">{windowsLinkText(link)}. Windows-side tools and a browser on Windows cannot open the hopper at localhost.</p>
      <WindowsLinkFix link={link} />
    </div>
  );
}

/** The banner over every view: each online machine whose Windows link is broken, and the keep-alive loop's report. */
export function WindowsLinkNotice() {
  const machines = useHopper((s) => s.machines);
  const reported = useHopper((s) => s.windowsLink);
  const broken = brokenWindowsLinks(machines, reported);
  if (!broken.length) return null;
  return (
    <div data-windows-link-notice className="space-y-2 rounded-lg border border-warn/40 bg-warn/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><MonitorX className="size-4" />Windows does not reach the hopper on this PC</p>
      {broken.map((b) => (
        <div key={b.id} className="space-y-1">
          <p className="text-xs break-words">{b.name}: {windowsLinkText(b.link)}.</p>
          <WindowsLinkFix link={b.link} />
        </div>
      ))}
    </div>
  );
}
