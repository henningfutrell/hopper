// A login's browser profile on its card (issue #1249, `model/browser-profile.ts`): the profile's name, and the ways to open the
// sign-in page in it — a command for Chrome or Edge, copied, and a Firefox container link. The name is the same each time the
// same machine signs in as the same account, so the person sees which machine the page is for.
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { containerLink, platformOf, profileCommand, type ProfileBrowser } from '@/model/browser-profile';

const BROWSERS: [ProfileBrowser, string][] = [['chrome', 'Chrome'], ['edge', 'Edge']];

export function BrowserProfile({ profile, url }: { profile: string; url: string }) {
  const [copied, setCopied] = useState<ProfileBrowser | undefined>();
  const platform = platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent);
  const copy = (browser: ProfileBrowser) => void navigator.clipboard?.writeText(profileCommand({ profile, url, browser, platform })).then(() => {
    setCopied(browser);
    setTimeout(() => setCopied(undefined), 1500);
  }, () => {});
  return (
    <div data-slot="browser-profile" data-profile={profile} className="space-y-1.5 text-center text-xs text-muted-foreground">
      <div>Browser profile: <code className="font-mono text-foreground">{profile}</code></div>
      <div className="flex flex-wrap justify-center gap-1.5">
        {BROWSERS.map(([b, label]) => (
          <Button key={b} size="xs" variant="outline" title={`Copy a ${platform === 'windows' ? 'PowerShell' : 'shell'} command that opens the page in ${label} with this profile`} onClick={() => copy(b)}>
            {copied === b ? <Check className="text-ok" /> : <Copy />}{label} command
          </Button>
        ))}
        <Button asChild size="xs" variant="outline">
          <a href={containerLink(profile, url)} title="Open the page in the Firefox container of this name (needs the add-on Open external links in a container)"><ExternalLink />Firefox container</a>
        </Button>
      </div>
    </div>
  );
}
