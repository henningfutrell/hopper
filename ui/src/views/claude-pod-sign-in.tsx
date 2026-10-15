// The hopper's Claude sign-in for pods (issue #1287): an admin names the Claude account, and the hopper runs `claude
// setup-token` itself. Its login card shows above, with the account, the URL to open and a field for the code the page
// shows; one paste, and the token is the user's vault secret CLAUDE_TOKEN, which new job pods and lane pods start with.
import { LogIn, Server } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { actFor, refreshLogins } from '@/store';

export function ClaudePodSignIn() {
  const [account, setAccount] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const r = await actFor('/ui/api/logins/claude-setup-token', { account: account.trim() }, `Claude sign-in for ${account.trim()} started: open its card`);
    setBusy(false);
    if (r.ok) await refreshLogins().catch(() => {});
  };
  return (
    <Panel title="Claude sign-in for pods" icon={Server} bodyClassName="space-y-2">
      <p className="text-sm text-muted-foreground">
        The hopper runs <span className="font-mono">claude setup-token</span> and keeps the token in your vault as <span className="font-mono">CLAUDE_TOKEN</span>.
        New job pods and lane pods then start signed in, also after a restart. Sign in as the account you name here.
      </p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void start(); }}>
        <input aria-label="Claude account" type="email" required placeholder="Claude account (email)" className={`${FIELD} w-72`} value={account} disabled={busy} onChange={(e) => setAccount(e.target.value)} />
        <Button data-claude-pod-sign-in type="submit" size="sm" disabled={busy || !account.trim()}><LogIn />Sign in</Button>
      </form>
    </Panel>
  );
}
