// The credential check on Machines (issues #1248, #1459, #1467): a card's one state, the one the decider acts on
// (`credentialCard`, from the daemon's `credentialHeld`), and the admin's strict mode. Held: the reason and the guided fix
// first, and Use anyway. Taking jobs: a one-line warning, the guided fix folded under Reduce risk, and Acknowledge or Stop
// taking jobs. Acknowledged: the warning folded until a new credential is found.
import { KeyRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Panel } from '@/components/panel';
import { StatusBadge } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { get, post, RoleRefused, SessionRejected } from '@/lib/api';
import { credentialCard, jobUserFix, type CredentialCard } from '@/model/machines';
import type { MachineView } from '@/model/wire';
import { refreshLive, useHopper } from '@/store';

/** The card's badge for the credential check; null when its job user holds none. */
export function CredentialBadge({ m }: { m: MachineView }) {
  const card = credentialCard(m);
  return card ? <StatusBadge status={card.badge} tone={card.state === 'acknowledged' ? 'muted' : 'warn'} /> : null;
}

/** The guided fix (issue #1248): the commands that make a dedicated job user, and how the machine moves to it. */
function JobUserSteps({ m }: { m: MachineView }) {
  const fix = jobUserFix(m);
  if (!fix) return null;
  const commands = fix.commands.join('\n');
  return (
    <div className="grid gap-1.5">
      <p className="text-xs text-muted-foreground">To set up a dedicated job user, run these on that machine as an admin:</p>
      <div className="flex flex-wrap items-start gap-2 text-xs">
        <code data-slot="job-user-commands" className="min-w-0 flex-1 rounded-md border bg-muted/40 p-2 font-mono break-all whitespace-pre-wrap">{commands}</code>
        <Button type="button" size="sm" variant="outline" className="min-h-9" onClick={() => void navigator.clipboard?.writeText(commands).then(() => toast.success('Copied'), () => toast.error('Clipboard blocked'))}>Copy</Button>
      </div>
      <p className="text-xs text-muted-foreground">{fix.then}</p>
    </div>
  );
}

const act = async (m: MachineView, what: 'accept' | 'revoke', done: string) => {
  const body = what === 'accept' ? { machineKey: m.id, credentials: m.infraCredentials ?? [] } : { machineKey: m.id };
  try {
    await post(`/ui/api/machines/${encodeURIComponent(m.id)}/credentials/${what}`, body);
    toast.success(done);
    await refreshLive();
  } catch (e) {
    if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
    toast.error(e instanceof RoleRefused ? 'Only an admin changes the credential check' : (e as Error).message);
  }
};

/** The card's credential part: its state's headline, what its job user holds, the guided fix and the actions. */
export function CredentialCheck({ m, authed, busy }: { m: MachineView; authed: boolean; busy: boolean }) {
  const card: CredentialCard | null = credentialCard(m);
  if (!card) return null;
  const acts = authed && !busy;
  if (card.state === 'held') {
    return (
      <div role="alert" data-slot="infra-credentials" data-state="held" className="grid gap-1.5 text-sm">
        <p data-slot="credential-headline" className="font-semibold text-warn">{card.headline}</p>
        <p className="text-warn">{card.detail}</p>
        <JobUserSteps m={m} />
        {acts && <div className="flex gap-2"><Button type="button" size="sm" variant="destructive" onClick={() => void act(m, 'accept', 'Taking jobs')}>Use anyway</Button><span className="self-center text-xs text-muted-foreground">Accept the blast-radius risk and let this machine take jobs</span></div>}
      </div>
    );
  }
  const warning = card.state === 'warning';
  return (
    <div role={warning ? 'alert' : undefined} data-slot="infra-credentials" data-state={card.state} className="grid gap-1.5 text-sm">
      <p data-slot="credential-headline" className="font-semibold">{card.headline}</p>
      <p className={warning ? 'text-warn' : 'text-xs text-muted-foreground'}>{card.detail}{card.added.length > 0 && ` New since it was acknowledged: ${card.added.join(', ')}.`}{!warning && ' An admin acknowledged it.'}</p>
      <details className="text-xs">
        <summary className="cursor-pointer text-muted-foreground">Reduce risk</summary>
        <div className="mt-1.5 grid gap-1.5">
          <p className="text-muted-foreground">A job on this machine could use these credentials. Run its jobs as a dedicated user that holds none, or in a pod sandbox; a job that needs a credential gets it from the vault, through a grant.</p>
          <JobUserSteps m={m} />
        </div>
      </details>
      {acts && (
        <div className="flex flex-wrap gap-2">
          {warning && <Button type="button" size="sm" variant="outline" onClick={() => void act(m, 'accept', 'Acknowledged')}>Acknowledge</Button>}
          <Button type="button" size="sm" variant="outline" onClick={() => void act(m, 'revoke', 'Not taking jobs')}>Stop taking jobs</Button>
        </div>
      )}
    </div>
  );
}

/** Strict mode (issue #1467), an admin's: every machine with credentials no admin acknowledged takes no job. Off by default. */
export function CredentialCheckPanel() {
  const [strict, setStrict] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get<{ strict: boolean }>('/api/credential-check').then((v) => { if (typeof v?.strict === 'boolean') setStrict(v.strict); }, () => {}); }, []);
  const save = async (on: boolean) => {
    setBusy(true);
    try {
      setStrict((await post<{ strict: boolean }>('/ui/api/credential-check', { strict: on })).strict);
      toast.success(on ? 'Strict mode on' : 'Strict mode off');
      await refreshLive();
    } catch (e) {
      if (e instanceof SessionRejected) useHopper.setState({ authed: false, user: null });
      toast.error(e instanceof RoleRefused ? 'Only an admin changes the credential check' : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <Panel title="Credential check" icon={KeyRound}>
      {strict === null ? <p className="text-sm text-muted-foreground">Loading…</p> : (
        <div data-slot="credential-check" className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">A machine whose job user holds credentials a job could use takes jobs with a warning. Strict mode holds it until an admin uses it anyway. Turn it on for a shared or hosted hopper.</p>
          <label className="flex items-center gap-2">
            <Switch checked={strict} disabled={busy} aria-label="Strict mode" onCheckedChange={(on) => void save(on)} />
            Strict mode: hold machines with credentials
          </label>
        </div>
      )}
    </Panel>
  );
}
