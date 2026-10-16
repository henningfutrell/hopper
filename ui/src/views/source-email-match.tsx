// Settings → Sign-in → Source email match (issue #1380): whether a GitHub account a person connects from Sources must have,
// among its verified emails, the email they signed in with. On by default; the hopper's admin turns it off here
// (GET /api/source-email-match, POST /ui/api/source-email-match). Each renewal of an account's token checks it again.
import { MailCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { Switch } from '@/components/ui/switch';
import { get, post, SessionRejected } from '@/lib/api';
import { useHopper } from '@/store';

export function SourceEmailMatch() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { void get<{ on: boolean }>('/api/source-email-match').then((v) => setOn(v.on), (e: unknown) => toast.error((e as Error).message)); }, []);
  const save = async (next: boolean) => {
    setBusy(true);
    try {
      setOn((await post<{ on: boolean }>('/ui/api/source-email-match', { on: next })).on);
      toast.success(next ? 'Source email match is on' : 'Source email match is off');
    } catch (err) {
      if (err instanceof SessionRejected) useHopper.setState({ authed: false });
      toast.error((err as Error).message);
    } finally { setBusy(false); }
  };
  return (
    <Panel title="Source email match" icon={MailCheck}>
      <div data-section="source-email-match" className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          When it is on, a person can connect only a GitHub account that has the email they signed in with as a verified email. The hopper checks it again each time it renews the account's token. An account that lost the email stops, and Sources asks to connect it again. The person stays signed in.
        </p>
        {on === null ? <p className="text-muted-foreground">Loading…</p> : (
          <label className="flex items-center gap-2">
            <Switch checked={on} disabled={busy} aria-label="Source email match" onCheckedChange={(next) => void save(next)} />
            A connected GitHub account must have the email its person signed in with
          </label>
        )}
      </div>
    </Panel>
  );
}
