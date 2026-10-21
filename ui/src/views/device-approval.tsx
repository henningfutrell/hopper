// Users & access → API tokens: approve a device (issue #892). An agent that asks for a grant shows a user code; the person
// enters it here (or opens the link the agent shows, which holds it), sees what the agent asks for and who asked, and
// approves or denies it. Approved, the grant is the person's own mint: its role at most theirs. The agent gets the grant's
// first pair at its next poll; nothing is shown here.
import { MonitorSmartphone } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/vault-fields';
import { get, post, SessionRejected } from '@/lib/api';
import { deviceAskLine, deviceCodeOfHash } from '@/model/api-tokens';
import type { DeviceGrantView, ScopeRegistry, UiRole } from '@/model/wire';
import { useHopper } from '@/store';

const fail = (e: unknown): void => {
  if (e instanceof SessionRejected) useHopper.setState({ authed: false });
  toast.error((e as Error).message);
};

const pathOf = (typed: string): string => `/api/api-tokens/device/${encodeURIComponent(typed.trim())}`;

export function DeviceApproval({ role, registry, onApproved }: { role: UiRole | undefined; registry: ScopeRegistry | undefined; onApproved: () => void }) {
  const [code, setCode] = useState(() => deviceCodeOfHash(window.location.hash));
  const [found, setFound] = useState<DeviceGrantView | undefined>();
  const [busy, setBusy] = useState(false);

  const lookUp = async (typed: string): Promise<void> => {
    setBusy(true);
    try {
      setFound(await get<DeviceGrantView>(pathOf(typed)));
    } catch (e) {
      setFound(undefined);
      fail(e);
    } finally {
      setBusy(false);
    }
  };
  // A link the agent showed holds the code: look it up at once.
  useEffect(() => {
    const linked = deviceCodeOfHash(window.location.hash);
    if (linked) get<DeviceGrantView>(pathOf(linked)).then(setFound, fail);
  }, []);

  const answer = async (action: 'approve-device' | 'deny-device'): Promise<void> => {
    if (!found) return;
    setBusy(true);
    try {
      await post('/ui/api/api-tokens', { action, code: found.userCode });
      toast.success(action === 'approve-device' ? `Approved: ${found.ask.label} gets its grant at its next poll` : `Denied: ${found.ask.label} is told`);
      setFound(undefined);
      setCode('');
      if (action === 'approve-device') window.setTimeout(onApproved, 6000);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="flex items-center gap-2 text-sm font-medium"><MonitorSmartphone className="size-4" />Approve a device</p>
      <p className="text-xs text-muted-foreground">An agent that asks for a grant shows a code. Enter it to see what the agent asks for. Approve only a code you got from the agent yourself.</p>
      <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void lookUp(code); }}>
        <label className="block space-y-1"><Label>Code</Label>
          <Input className="h-9 w-36 font-mono text-sm uppercase" name="device-code" value={code} maxLength={16} placeholder="BCDF-GHJK" onChange={(e) => setCode(e.target.value)} /></label>
        <Button type="submit" size="sm" variant="outline" disabled={busy || code.trim().length < 8}>Look up</Button>
      </form>
      {found && (
        <div className="space-y-2 rounded-md border border-warn p-3">
          <p className="text-sm font-medium break-all">{found.ask.label}{found.ask.holder ? ` (${found.ask.holder})` : ''} asks for a grant · {found.userCode}</p>
          <p className="text-xs text-muted-foreground">{deviceAskLine(found, role, registry)}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void answer('approve-device')}>Approve</Button>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => void answer('deny-device')}>Deny</Button>
          </div>
        </div>
      )}
    </div>
  );
}
