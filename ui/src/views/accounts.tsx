// Accounts (issue #1128, design.md "Tool accounts"): who each machine's agent tool is signed in as. One card per tool account — the
// service and identity, the plan, the machines signed in as it with their sign-in, when each was read and last ran a job, and the
// account's week windows (its spend) —, and one for the machines signed in as nobody. Read from GET /api/tool-accounts, shared with
// the nav badge. Never a token. Sign in (issue #1128, an operator): starts the tool's sign-in on that machine, which waits in Logins
// for the person to open its page and paste the code it shows. A machine whose job user holds infra credentials is flagged as not
// ready, with their names (issues #1128 part 7, #1248). A machine not signed in says who it was last signed in as (issue #1269).
// Each card folds, and stays folded over a reload (issue #2353).
import { LogIn, UserRound } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Empty, Panel } from '@/components/panel';
import { ReadingGauge } from '@/components/reading';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { lastAccountText } from '@/model/logins';
import { accountTitle, LOGIN_LABEL, LOGIN_TONE, machineLine } from '@/model/tool-accounts';
import { accountFacts } from '@/model/usage';
import type { ToolAccount, ToolAccountMachine } from '@/model/wire';
import { actFor, refreshLogins } from '@/store';
import { useToolAccounts } from '@/store/polled';
import { useCanOperate } from '@/store/selectors';

/** Start the tool's sign-in on the machine, then go to Logins, where it waits for its code. */
function SignIn({ m }: { m: ToolAccountMachine }) {
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    const r = await actFor('/ui/api/tool-accounts/sign-in', { source: m.source }, `Sign-in started on ${m.label}: open it in Logins`);
    setBusy(false);
    if (!r.ok) return;
    await refreshLogins().catch(() => {});
    window.location.hash = '#logins';
  };
  return (
    <Button data-sign-in={m.source} size="sm" variant={m.login === 'signed-out' ? 'default' : 'outline'} disabled={busy} onClick={() => void start()}>
      <LogIn />{m.login === 'signed-out' ? 'Sign in' : 'Sign in again'}
    </Button>
  );
}

function AccountCard({ a, now }: { a: ToolAccount; now: number }) {
  const canOperate = useCanOperate();
  const facts = accountFacts({ ...a, role: 'usage-source', instance: '' });
  return (
    <Panel title={accountTitle(a)} icon={UserRound} count={a.machines.length} fold={`accounts.${a.service}/${a.identity ?? a.login}`} action={<StatusBadge status={a.login} label={LOGIN_LABEL[a.login]} tone={LOGIN_TONE[a.login]} />} bodyClassName="space-y-3">
      <div data-slot="tool-account" className="space-y-3">
        {facts.length > 0 && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {facts.map(([k, v]) => <div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>)}
          </dl>
        )}
        <ul className="divide-y">
          {a.machines.map((m) => (
            <li key={`${m.source}/${m.machineId}`} data-slot="tool-account-machine" className="space-y-0.5 py-2 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{m.label}</span>
                <StatusBadge status={m.login} label={LOGIN_LABEL[m.login]} tone={LOGIN_TONE[m.login]} />
                <code className="ml-auto font-mono text-[11px] text-muted-foreground">{m.source}</code>
              </div>
              <div className="num text-xs text-muted-foreground">{machineLine(m, now)}</div>
              {m.problem && <div className="text-xs break-words text-warn">{m.problem}</div>}
              {m.lastAccount !== undefined && <div data-slot="last-account" className="text-xs break-words">{lastAccountText(m.lastAccount, m.label)}</div>}
              {m.infraCredentials?.length ? <div data-slot="infra-credentials" className="text-xs break-words text-warn">its job user holds credentials a job could use: {m.infraCredentials.join(', ')}</div> : null}
              {canOperate && m.signIn && <div className="pt-1"><SignIn m={m} /></div>}
            </li>
          ))}
        </ul>
        {a.spend.length > 0 && (
          <div data-slot="tool-account-spend" className="flex flex-wrap justify-around gap-x-2 gap-y-4 border-t pt-3">
            {a.spend.map((r) => <ReadingGauge key={r.window} r={r} now={now} />)}
          </div>
        )}
      </div>
    </Panel>
  );
}

export function Accounts() {
  const now = useNow();
  const report = useToolAccounts();
  if (!report) return <Panel title="Accounts" icon={UserRound}><Empty>reading the tool accounts…</Empty></Panel>;
  if (!report.accounts.length) return <Panel title="Accounts" icon={UserRound}><Empty>no usage source reads a tool account yet: add one for each machine in <a className="underline" href="#plugins">Plugins</a> (claude-plan)</Empty></Panel>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {report.accounts.map((a) => <AccountCard key={`${a.service}/${a.identity ?? a.login}`} a={a} now={now} />)}
    </div>
  );
}
