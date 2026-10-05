// gh login (issue #138, design.md "gh login"): log the gh CLI in to GitHub from the UI — no terminal,
// no token in .env. Start shows gh's device code; the GitHub user enters it at the link, and the
// panel follows gh until it is logged in. Hidden where there is no gh.
import { GitBranch, LogIn, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { get, post, SessionRejected } from '@/lib/api';
import type { GhLoginStatus } from '@/model/wire';
import { useHopper } from '@/store';
import { useCanAdmin } from '@/store/selectors';

const POLL_MS = 2000;

export function GhLoginPanel() {
  const [s, setS] = useState<GhLoginStatus | null>(null);
  const canAdmin = useCanAdmin();
  const waiting = s?.state === 'waiting';
  useEffect(() => {
    let live = true;
    const read = () => get<GhLoginStatus>('/api/gh-login').then((v) => { if (live) setS(v); }, () => {});
    void read();
    const t = waiting ? setInterval(read, POLL_MS) : undefined;
    return () => { live = false; if (t) clearInterval(t); };
  }, [waiting]);
  if (!s || s.state === 'unavailable') return null;

  const act = async (action: 'start' | 'cancel') => {
    try { setS(await post<GhLoginStatus>('/ui/api/gh-login', { action })); } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((e as Error).message);
    }
  };
  const tone = s.state === 'logged-in' ? 'ok' : s.state === 'failed' ? 'bad' : 'warn';
  return (
    <Panel title="GitHub (gh)" icon={GitBranch} action={<StatusBadge status={s.state} tone={tone} />} bodyClassName="space-y-2 text-xs">
      {s.state === 'logged-in' && <div>gh is logged in{s.account && <> as <span className="font-mono">{s.account}</span></>}; the github source and jobs' git use it.</div>}
      {s.state === 'waiting' && <>
        <div>Open <a className="underline" href={s.verificationUri} target="_blank" rel="noreferrer">{s.verificationUri}</a>, sign in as the GitHub user the hopper should act as, and enter this code:</div>
        <div className="flex items-center gap-3">
          <code data-gh-device-code className="rounded border px-2 py-1 font-mono text-lg font-semibold tracking-widest select-all">{s.userCode}</code>
          <Button size="xs" variant="outline" disabled={!canAdmin} onClick={() => void act('cancel')}><X />Cancel</Button>
        </div>
        <div className="text-muted-foreground">waiting for GitHub — this panel changes once the code is approved</div>
      </>}
      {(s.state === 'logged-out' || s.state === 'failed') && <>
        {s.state === 'failed' && <div className="rounded-md border border-bad/30 bg-bad/5 p-2 break-words text-bad">{s.error}</div>}
        <div>gh is not logged in: the github source cannot read issues and jobs cannot push.</div>
        <Button size="xs" disabled={!canAdmin} title={canAdmin ? 'Shows a code to enter on github.com' : 'An admin can log gh in: sign in as one'} onClick={() => void act('start')}><LogIn />Log in to GitHub</Button>
      </>}
    </Panel>
  );
}
