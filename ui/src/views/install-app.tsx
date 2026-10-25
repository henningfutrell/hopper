// Install the hopper's app on GitHub (issue #2759): one prominent button that opens GitHub's install page, where a person
// picks their own account or an organization and the repositories the app reaches there. At the top of Sources' GitHub
// section in every state but a personal access token's, quieter once the app reaches a repository; on the Dashboard only
// while it reaches none, so a person setting up the hopper finds it first. The link comes from the daemon
// (`installUrl`, GET /api/connected-accounts): a hopper with no app shows none.
import { ExternalLink, PackagePlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { get } from '@/lib/api';
import type { ConnectedAccountStatus } from '@/model/wire';

/** The app reaches no repository yet: not connected, or connected and installed nowhere. Undefined while not known. */
export function installNeeded(s: ConnectedAccountStatus): boolean | undefined {
  if (s.state !== 'connected') return true;
  return s.installations === undefined ? undefined : s.installations.every((i) => i.repositories.length === 0);
}

export function InstallAppCallout({ s }: { s: ConnectedAccountStatus | undefined }) {
  if (!s?.installUrl) return null;
  const needed = installNeeded(s) === true;
  return (
    <div data-install-app-callout className={needed ? 'flex flex-wrap items-center gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-xs' : 'flex flex-wrap items-center gap-3 text-xs'}>
      {needed && <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 text-sm font-medium"><PackagePlus className="size-4" />Install the hopper app on GitHub</div>
        <div className="text-muted-foreground">
          The app reaches only the repositories it is installed on. Install it on your own account or an organization, and choose its repositories on GitHub.
        </div>
      </div>}
      <Button asChild size={needed ? 'default' : 'xs'} variant={needed ? 'default' : 'outline'}>
        <a data-install-app={needed ? 'needed' : 'more'} href={s.installUrl} target="_blank" rel="noreferrer">
          {needed ? 'Install the app on GitHub' : 'Install the app on another account or organization'}<ExternalLink data-icon="inline-end" />
        </a>
      </Button>
    </div>
  );
}

/** The Dashboard's: the callout while the first GitHub account's app reaches no repository, read once. An answer with no
 *  accounts shows nothing (issue #2769). */
export function InstallAppNudge() {
  const [s, setS] = useState<ConnectedAccountStatus>();
  useEffect(() => {
    let live = true;
    void get<{ accounts?: ConnectedAccountStatus[] }>('/api/connected-accounts').then((v) => { if (live) setS(v.accounts?.find((a) => a.key === 'github')); }, () => {});
    return () => { live = false; };
  }, []);
  return s && installNeeded(s) === true ? <InstallAppCallout s={s} /> : null;
}
