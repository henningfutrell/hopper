// Accounts (issue #1128, design.md "Tool accounts"): who each machine's agent tool is signed in as. One card per tool account — the
// service and identity, the plan, the machines signed in as it with their sign-in, when each was read and last ran a job, and the
// account's week windows (its spend) —, and one for the machines signed in as nobody. Read from GET /api/tool-accounts, shared with
// the nav badge. Never a token.
import { UserRound } from 'lucide-react';
import { Empty, Panel } from '@/components/panel';
import { ReadingGauge } from '@/components/reading';
import { StatusBadge } from '@/components/status';
import { useNow } from '@/hooks/use-now';
import { accountTitle, LOGIN_LABEL, LOGIN_TONE, machineLine } from '@/model/tool-accounts';
import { accountFacts } from '@/model/usage';
import type { ToolAccount } from '@/model/wire';
import { useToolAccounts } from '@/store/polled';

function AccountCard({ a, now }: { a: ToolAccount; now: number }) {
  const facts = accountFacts({ ...a, role: 'usage-source', instance: '' });
  return (
    <Panel title={accountTitle(a)} icon={UserRound} count={a.machines.length} action={<StatusBadge status={a.login} label={LOGIN_LABEL[a.login]} tone={LOGIN_TONE[a.login]} />} bodyClassName="space-y-3">
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
  if (!report.accounts.length) return <Panel title="Accounts" icon={UserRound}><Empty>no usage source reads a tool account yet: add one for each machine in <a className="underline" href="#settings/plugins">Settings → Plugins</a> (claude-plan)</Empty></Panel>;
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {report.accounts.map((a) => <AccountCard key={`${a.service}/${a.identity ?? a.login}`} a={a} now={now} />)}
    </div>
  );
}
