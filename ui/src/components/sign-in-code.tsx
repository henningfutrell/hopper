// A tool sign-in's step for the person (issue #1128, design.md "Tool sign-in"): open the sign-in page, sign in there, paste the
// code the page shows, send it. The hopper gives the code to the tool on the machine and answers once the tool ended: signed in,
// or why not. The code is sent once and never kept here.
import { ExternalLink, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BrowserProfile } from '@/components/browser-profile';
import { loginProfileName } from '@/model/browser-profile';
import type { LoginView } from '@/model/wire';
import { actFor, refreshLogins } from '@/store';

/** What the code route answers: the login, completed or failed with why. */
const notSignedIn = (answer: unknown): string | undefined => {
  const l = answer as Partial<LoginView> | undefined;
  return l?.status === 'failed' ? `Not signed in: ${l.reason ?? 'the tool did not say why'}` : undefined;
};

export function SignInCode({ l }: { l: LoginView }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    await actFor(`/ui/api/logins/${encodeURIComponent(l.id)}/code`, { code: code.trim() }, `${l.tool} is signed in`, notSignedIn);
    setCode('');
    setBusy(false);
    refreshLogins().catch(() => {});
  };
  const profile = loginProfileName(l);
  return (
    <form data-slot="sign-in-code" onSubmit={(e) => void send(e)} className="space-y-2 text-sm">
      <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
        <li>Open the sign-in page, in its browser profile, and sign in with the account this machine must use.</li>
        <li>Copy the code the page shows. Paste it here and send it.</li>
      </ol>
      {l.verificationUrl && (
        <>
          <Button asChild size="sm" variant="outline" className="w-full">
            <a data-open-sign-in href={l.verificationUrl} target="_blank" rel="noopener noreferrer"><ExternalLink />Open the sign-in page</a>
          </Button>
          <BrowserProfile profile={profile} url={l.verificationUrl} />
        </>
      )}
      <div className="flex gap-2">
        <Input aria-label="Code from the sign-in page" autoComplete="off" spellCheck={false} placeholder="Code from the sign-in page" value={code} disabled={busy} onChange={(e) => setCode(e.target.value)} />
        <Button type="submit" size="sm" disabled={busy || !code.trim()}><Send />Send</Button>
      </div>
    </form>
  );
}
