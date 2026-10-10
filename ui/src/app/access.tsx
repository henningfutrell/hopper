// Access checks unavailable (issue #696): the banner over every view while OpenFGA is not set up or not reached, with
// the compose fix, and the same fix in the update panel. OpenFGA is a required compose service; an install on an older
// compose.yaml lacks it. Not dismissable: it ends when OpenFGA answers.
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { get } from '@/lib/api';
import { ACCESS_DOCS_URL, accessDown, type AccessStatusView } from '@/model/access-status';
import { useHopper } from '@/store';

/** How often the state is read again: a fixed stack clears the banner without a reload. */
const POLL_MS = 60_000;

/** GET /api/access/status once signed in, then each minute; null until read, or when it cannot be read. */
export function useAccessStatus(): AccessStatusView | null {
  const authed = useHopper((s) => s.authed);
  const [status, setStatus] = useState<AccessStatusView | null>(null);
  useEffect(() => {
    if (!authed) return;
    const read = () => { get<AccessStatusView>('/api/access/status').then(setStatus, () => setStatus(null)); };
    read();
    const timer = setInterval(read, POLL_MS);
    return () => clearInterval(timer);
  }, [authed]);
  return status;
}

/** The compose fix: the `openfga` service in compose.yaml, then the stack up again. */
export function AccessFix() {
  return (
    <p className="text-xs text-muted-foreground">
      In containers: copy the <code>openfga</code> and <code>openfga-migrate</code> services from the current <code>compose.yaml</code> into
      yours, then run <code>podman-compose up -d</code> in its folder.{' '}
      <a className="underline" href={ACCESS_DOCS_URL} target="_blank" rel="noreferrer">How to set up OpenFGA</a>
    </p>
  );
}

export function AccessBanner({ status }: { status: AccessStatusView | null }) {
  const why = accessDown(status);
  if (why === undefined) return null;
  return (
    <div data-access-notice={status!.state} className="space-y-1 rounded-lg border border-bad/40 bg-bad/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-bad"><ShieldAlert className="size-4" />Access checks are off: OpenFGA isn't running</p>
      <p className="break-words text-bad">{why}</p>
      <p className="text-xs text-muted-foreground">Settings that need it, such as the TypeSafe API key, cannot be saved until then. Nothing else changes.</p>
      <AccessFix />
    </div>
  );
}

export function AccessNotice() {
  return <AccessBanner status={useAccessStatus()} />;
}
