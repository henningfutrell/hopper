// Logins (issue #477): the logins jobs and escalation runs wait on (issue #476), apart from the questions — one
// card each, the least time left on top. A card names the machine, the tool and what waits on it, and shows the
// code with copy and open (`DeviceCode`) and a countdown of server time. Under the warning it warns, and a screen
// reader hears that once; at `expiresAt` the code goes and the card says Expired, on the browser's clock before the
// server's `auth.expired` arrives, whose word is final. Completed, cancelled and failed say so. Ended logins stay a
// short while, then go to Earlier logins below. A session whose UI role cannot act (viewer) sees a notice, never
// the code (the server answers it none either). A 403 on an action drops the UI to the landing page.
import { Ban, Check, KeyRound, Lock, RotateCw, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Confirm } from '@/components/confirm';
import { DeviceCode } from '@/components/device-code';
import { JobTitle } from '@/components/job';
import { Empty, Panel } from '@/components/panel';
import { RaisedOn } from '@/components/raised-by';
import { StatusBadge } from '@/components/status';
import { cn } from '@/lib/utils';
import { clock } from '@/model/format';
import { countdownText, isOpen, onCard, phaseOf, sortByTimeLeft, type LoginPhase } from '@/model/logins';
import type { LoginSettings, LoginView } from '@/model/wire';
import { actFor, refreshLogins, useHopper } from '@/store';
import { useCanAdmin, useCanOperate, useJobIndex, useMachineName, useServerNow } from '@/store/selectors';
import { LoginHistory, LoginSettingsPanel } from './login-settings';

const BORDER: Record<LoginPhase, string> = {
  pending: '', expiring: 'border-warn/60 bg-warn/5', expired: 'border-bad/40', completed: 'border-ok/40', cancelled: '', failed: 'border-bad/40',
};
const TONE: Record<LoginPhase, 'warn' | 'bad' | 'ok' | 'muted'> = { pending: 'warn', expiring: 'warn', expired: 'bad', completed: 'ok', cancelled: 'muted', failed: 'bad' };
const LABEL: Record<LoginPhase, string> = { pending: 'pending', expiring: 'expires soon', expired: 'expired', completed: 'signed in', cancelled: 'cancelled', failed: 'failed' };

/** What waits on the login, as a noun: the job, or the escalation run. */
const waiter = (l: LoginView): string => (l.jobId ? 'The job' : 'The escalation run');

/** What happened to what waited on it, for an ended login. */
function outcome(l: LoginView, phase: LoginPhase, settings: LoginSettings): string {
  switch (phase) {
    case 'expired':
      if (!l.jobId) return 'The escalation run stops waiting on it; the question goes on as on any error.';
      if (settings.onExpiry === 'fail') return 'The job fails: its login expired before it was completed.';
      return l.renewable ? 'The job waits for a new code until its own timeout.' : 'The job waits until its own timeout; its run cannot ask for a new code.';
    case 'completed': return `${waiter(l)} goes on.`;
    case 'cancelled': return l.jobId ? 'The job was told to go on without it, or to fail.' : 'The escalation run stops waiting on it.';
    case 'failed': return l.reason ? `Failed: ${l.reason}.` : 'Failed.';
    default: return '';
  }
}

function LoginCard({ l, now, settings }: { l: LoginView; now: number; settings: LoginSettings }) {
  const phase = phaseOf(l, now, settings);
  const canAct = useCanOperate();
  const role = useHopper((s) => s.user?.role);
  const job = useJobIndex().get(l.jobId ?? '');
  const machine = useMachineName(l.machineId);
  const [busy, setBusy] = useState(false);
  const left = countdownText(l, now);
  const open = isOpen(phase);
  const act = async (what: 'cancel' | 'new-code') => {
    setBusy(true);
    await actFor(`/ui/api/logins/${encodeURIComponent(l.id)}/${what}`, {}, what === 'cancel' ? 'Login cancelled' : 'Asked for a new code');
    setBusy(false);
    refreshLogins().catch(() => {});
  };
  // A new code: while it is pending, or expired and held for one; only a run that can ask its tool.
  const canRenew = l.renewable && (open || (phase === 'expired' && settings.onExpiry === 'hold'));
  const actions = canAct && (open || canRenew) && (
    <div className="flex flex-wrap justify-center gap-2">
      {canRenew && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act('new-code')}><RotateCw />Request a new code</Button>}
      {open && (
        <Confirm title={`Cancel the ${l.tool} login?`} description={l.jobId ? 'The job is told to stop waiting on it, and to go on without it or fail.' : 'The escalation run stops waiting on it.'}
          action="Cancel login" onConfirm={() => void act('cancel')}>
          <Button size="sm" variant="ghost" disabled={busy}><X />Cancel</Button>
        </Confirm>
      )}
    </div>
  );
  const name = machine ?? 'machine unknown';
  return (
    <div data-login={l.id} data-phase={phase} className="min-w-0">
      <Panel title={`${l.tool} login`} icon={KeyRound} className={BORDER[phase]} bodyClassName="space-y-3"
        action={<span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
          <RaisedOn raisedBy={l.machineId ? { machineId: l.machineId, ...(machine ? { name: machine } : {}) } : undefined} />
          <StatusBadge status={phase} tone={TONE[phase]} label={LABEL[phase]} />
        </span>}>
        <span data-login-announce aria-live="polite" className="sr-only">
          {phase === 'expiring' ? `The ${l.tool} login on ${name} expires soon.` : phase === 'expired' ? `The ${l.tool} login on ${name} expired.` : ''}
        </span>
        <div className="flex items-start gap-2 text-sm">
          <span className="shrink-0 text-xs text-muted-foreground">Waiting:</span>
          {job ? <JobTitle job={job} className="flex-1" />
            : <span className="min-w-0 flex-1 truncate">{l.jobId ? `job ${l.jobId.slice(0, 8)}` : `the ${l.run} escalation run for a question`}</span>}
        </div>
        {open && (
          <div className={cn('text-center text-sm text-muted-foreground', phase === 'expiring' && 'text-base font-semibold text-warn')}>
            The code expires in <span data-countdown className="num">{left}</span>
          </div>
        )}
        {open && canAct && l.userCode && l.verificationUrl && (
          <DeviceCode provider={l.tool} userCode={l.userCode} verificationUri={l.verificationUrl} waiting="Waiting for the sign-in" actions={actions || undefined} />
        )}
        {open && canAct && !l.codeKept && (
          <div className="text-center text-sm text-muted-foreground">The hopper no longer holds this code (it restarted).{l.renewable ? ' Request a new one.' : ''}</div>
        )}
        {open && canAct && !l.userCode && actions}
        {!open && (
          <div className="space-y-1 text-center text-sm">
            <div className={cn('flex items-center justify-center gap-1.5 font-medium', TONE[phase] === 'ok' ? 'text-ok' : TONE[phase] === 'bad' ? 'text-bad' : 'text-muted-foreground')}>
              {phase === 'completed' ? <><Check className="size-4" />Signed in{l.endedAt && <> at {clock(l.endedAt)}</>}</>
                : phase === 'expired' ? <><Ban className="size-4" />Expired</>
                  : phase === 'cancelled' ? <><X className="size-4" />Cancelled{l.endedAt && <> at {clock(l.endedAt)}</>}</> : <><X className="size-4" />Not signed in</>}
            </div>
            <div className="text-muted-foreground">{outcome(l, phase, settings)}</div>
            {actions}
          </div>
        )}
        {!canAct && (
          <div data-slot="login-notice" className="flex flex-wrap items-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
            <Lock className="size-4" />Your role ({role}) cannot see the code or act on logins; an operator or admin can.
          </div>
        )}
      </Panel>
    </div>
  );
}

export function Logins() {
  const logins = useHopper((s) => s.logins);
  const settings = useHopper((s) => s.loginSettings);
  const now = useServerNow();
  const canAdmin = useCanAdmin();
  if (!settings) return <Panel title="Logins" icon={KeyRound}><Empty>logins not read yet</Empty></Panel>;
  const sorted = sortByTimeLeft(logins, now, settings);
  const cards = sorted.filter((l) => onCard(l, now, settings));
  const earlier = sorted.filter((l) => !onCard(l, now, settings));
  return (
    <div className="space-y-3">
      {cards.length
        ? <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">{cards.map((l) => <LoginCard key={l.id} l={l} now={now} settings={settings} />)}</div>
        : <Panel title="Logins" icon={KeyRound}><Empty>no pending logins</Empty></Panel>}
      {earlier.length > 0 && <LoginHistory logins={earlier} />}
      {canAdmin && <LoginSettingsPanel settings={settings} />}
    </div>
  );
}
