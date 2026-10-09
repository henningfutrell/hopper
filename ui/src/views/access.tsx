// Settings → Access (issue #559): OpenFGA decides each credential a job is given. Whether OpenFGA can be asked, and
// why not (every credential is denied meanwhile); each template's approvals, each with the relationship chain from
// the template to the asset and Revoke (the next check is denied), and its blast radius with the reasons (issue #584);
// a check tried for a template, an operation and an asset, answered with its path; the permission matrix (issue #581):
// each requester — a user, a live job, a box — a row, each asset a column, each cell what it may do with the path; the
// newest decisions; and the access model, saved against the version read. The instance admin's alone: anyone else is
// told so.
import { KeySquare } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { TemplateRadiusBadge, TemplateRadiusReasons } from '@/components/template-radius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { usePoll } from '@/hooks/use-poll';
import { get, post } from '@/lib/api';
import { chainText, requesterKey, requesterText } from '@/model/access';
import { clock } from '@/model/format';
import type { AccessDecisionRecord, AccessStatus, AccessView, Approval, Asset, Operation, AssetKind, RequesterRow } from '@/model/wire';

const POLL_MS = 10_000;
const OPERATIONS: Operation[] = ['read', 'write', 'sync', 'apply'];
const ASSET_KINDS: AssetKind[] = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'];

const profileText = (a: Pick<Approval, 'profile'>) => `${a.profile.operation} on ${a.profile.asset.kind} ${a.profile.asset.name}`;

function Status({ status }: { status: AccessStatus }) {
  const text = status.state === 'connected' ? `OpenFGA is connected: every approval is pushed${status.syncedAt ? ` (${clock(status.syncedAt)})` : ''}.`
    : status.state === 'not-configured' ? `OpenFGA is not set up, so every credential is denied: ${status.why ?? ''}`
      : `OpenFGA cannot be asked, so every credential is denied: ${status.why ?? 'not reached'}`;
  return (
    <p data-access-state={status.state} className="flex flex-wrap items-center gap-2 text-sm">
      <StatusBadge status={status.state} tone={status.state === 'connected' ? 'ok' : 'bad'} />
      <span className="min-w-0 break-words">{text}</span>
    </p>
  );
}

function Approvals({ view, onChanged }: { view: AccessView; onChanged: (v: AccessView) => void }) {
  const [busy, setBusy] = useState(false);
  const revoke = async (a: Approval) => {
    setBusy(true);
    try {
      onChanged(await post<AccessView>('/ui/api/access', { action: 'revoke', approval: a.id }));
      toast.success(`Revoked: ${a.template} may no longer ${profileText(a)}`);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  const count = view.templates.reduce((n, t) => n + t.approvals.length, 0);
  return (
    <Panel title="Approvals" icon={KeySquare} count={count}>
      {view.templates.length === 0 ? <Empty>No template is approved for anything: every credential is denied.</Empty> : (
        <div className="space-y-3">
          {view.templates.map((t) => (
            <section key={t.template} data-template={t.template} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-mono text-sm font-medium">{t.template}</h3>
                <TemplateRadiusBadge radius={t.radius} />
              </div>
              <TemplateRadiusReasons radius={t.radius} />
              {t.radius.profiles.some((p) => !p.approved) && (
                <p className="text-xs text-warn">Waits for approval on Settings → Vault: {t.radius.profiles.filter((p) => !p.approved).map((p) => `${p.profile.operation} on ${p.profile.asset.kind} ${p.profile.asset.name}`).join(', ')}</p>
              )}
              {t.approvals.length > 0 && <ul className="divide-y rounded-lg border">
                {t.approvals.map((a) => (
                  <li key={a.id} data-approval={a.id} className="flex min-w-0 flex-wrap items-start gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="font-medium">{profileText(a)}</div>
                      <div className="text-xs break-words text-muted-foreground">{chainText(a.chain)}</div>
                      <div className="text-xs text-muted-foreground">approved by {a.approvedBy} at {clock(a.approvedAt)}</div>
                    </div>
                    <Confirm title={`Revoke ${t.template}: ${profileText(a)}?`} action="Revoke" onConfirm={() => void revoke(a)}
                      description={`Jobs from ${t.template} get no new ${a.profile.operation} credential for ${a.profile.asset.kind} ${a.profile.asset.name} from the next request. Approving it again takes a new approval.`}>
                      <Button size="xs" variant="outline" disabled={busy}>Revoke</Button>
                    </Confirm>
                  </li>
                ))}
              </ul>}
            </section>
          ))}
        </div>
      )}
      {view.revoked.length > 0 && (
        <details className="mt-3 text-xs text-muted-foreground">
          <summary>Revoked ({view.revoked.length})</summary>
          <ul className="mt-1 space-y-1">
            {view.revoked.map((r) => <li key={r.id} data-revoked={r.id}>{r.template}: {profileText(r)} — revoked by {r.revokedBy} at {clock(r.revokedAt)}</li>)}
          </ul>
        </details>
      )}
    </Panel>
  );
}

const assetKey = (a: Asset) => `${a.kind}/${a.name}`;

/** Where the requester runs: a job on its machine and template, a box of its template. */
function whereText(r: RequesterRow): string {
  if (r.requester.kind === 'job') return r.machine ? `on ${r.machine}${r.template ? `, template ${r.template}` : ', no template'}` : 'on no machine yet';
  return r.template ? `template ${r.template}` : '';
}

function Matrix({ view }: { view: AccessView }) {
  // The columns: every asset an approval names.
  const assets = [...new Map(view.templates.flatMap((t) => t.approvals.map((a) => [assetKey(a.profile.asset), a.profile.asset] as const))).values()]
    .sort((a, b) => assetKey(a).localeCompare(assetKey(b)));
  return (
    <Panel title="Who may do what" icon={KeySquare} count={view.requesters.length}>
      <div data-slot="access-matrix" className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Each requester now — every user, each live job, each box — and what it may do on each asset. A job reaches a template through the box it runs on; a user through their live jobs. Hover a cell for the path. The hopper's reading of its own rows: a model edit can allow more.
        </p>
        {assets.length === 0 ? <Empty>No template is approved for anything: no requester may do anything.</Empty> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Requester</th>
                  {assets.map((a) => <th key={assetKey(a)} data-asset={assetKey(a)} className="py-1 pr-3 font-medium whitespace-nowrap">{a.kind} {a.name}</th>)}
                </tr>
              </thead>
              <tbody>
                {view.requesters.map((r) => (
                  <tr key={requesterKey(r.requester)} data-requester={requesterKey(r.requester)} className="border-b last:border-b-0">
                    <td className="py-1 pr-3">
                      <div className="font-mono">{requesterText(r.requester)}</div>
                      {whereText(r) && <div className="text-muted-foreground">{whereText(r)}</div>}
                    </td>
                    {assets.map((a) => {
                      const grants = r.grants.filter((g) => assetKey(g.profile.asset) === assetKey(a));
                      return (
                        <td key={assetKey(a)} data-cell={assetKey(a)} className="py-1 pr-3 align-top"
                          {...(grants.length ? { title: grants.map((g) => chainText(g.path)).join('\n') } : {})}>
                          {grants.length ? grants.map((g) => g.profile.operation).join(', ') : '—'}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}

function DecisionLine({ d }: { d: AccessDecisionRecord }) {
  return (
    <div className="space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <StatusBadge status={d.allowed ? 'allowed' : 'denied'} tone={d.allowed ? 'ok' : 'bad'} />
        <span className="font-medium">{d.template ? `${d.template}: ` : ''}{d.operation} on {d.asset.kind} {d.asset.name}</span>
      </div>
      <div className="break-words">{d.reason}</div>
      {d.path && <div className="break-words text-muted-foreground">{chainText(d.path)}</div>}
    </div>
  );
}

function Check() {
  const [template, setTemplate] = useState('');
  const [operation, setOperation] = useState<Operation>('read');
  const [kind, setKind] = useState<AssetKind>('cluster');
  const [asset, setAsset] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AccessDecisionRecord | undefined>();
  const check = async () => {
    setBusy(true);
    try {
      setResult(await post<AccessDecisionRecord>('/ui/api/access', { action: 'check', template, operation, asset: { kind, name: asset } }));
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  return (
    <Panel title="Try a check" icon={KeySquare}>
      <div data-slot="access-check" className="space-y-2 text-sm">
        <p className="text-muted-foreground">What a live job from this template would get now: OpenFGA is asked as for a real credential, and the answer is recorded.</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Template</span>
            <Input name="template" className="h-8 w-44" value={template} disabled={busy} onChange={(e) => setTemplate(e.target.value)} /></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Operation</span>
            <select name="operation" className={`${FIELD} w-28`} value={operation} disabled={busy} onChange={(e) => setOperation(e.target.value as Operation)}>
              {OPERATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
            </select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Asset kind</span>
            <select name="kind" className={`${FIELD} w-48`} value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as AssetKind)}>
              {ASSET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select></label>
          <label className="grid gap-1"><span className="text-xs text-muted-foreground">Asset</span>
            <Input name="asset" className="h-8 w-44" value={asset} disabled={busy} onChange={(e) => setAsset(e.target.value)} /></label>
          <Button size="sm" disabled={busy || template === '' || asset === ''} onClick={() => void check()}>Check</Button>
        </div>
        {result && <div data-check-result={result.allowed ? 'allowed' : 'denied'} className="rounded-lg border p-2 text-xs"><DecisionLine d={result} /></div>}
      </div>
    </Panel>
  );
}

function Model({ view, onChanged }: { view: AccessView; onChanged: (v: AccessView) => void }) {
  const [dsl, setDsl] = useState(view.model.dsl);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onChanged(await post<AccessView>('/ui/api/access', { action: 'model', dsl, version: view.model.version }));
      toast.success('Access model saved: it applies from the next check');
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  return (
    <Panel title="Access model" icon={KeySquare}>
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          OpenFGA's model language. It may change how a job reaches an asset; it must keep every relation the hopper writes or asks. Saved by {view.model.writtenBy} at {clock(view.model.writtenAt)}.
        </p>
        <Textarea name="access-model" className="min-h-64 font-mono text-xs" value={dsl} disabled={busy} onChange={(e) => setDsl(e.target.value)} />
        <Button size="sm" disabled={busy || dsl === view.model.dsl} onClick={() => void save()}>Save model</Button>
      </div>
    </Panel>
  );
}

export function Access() {
  const [view, setView] = useState<AccessView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const load = useCallback(async () => {
    try { setView(await get<AccessView>('/api/access')); setError(undefined); } catch (e) { setError((e as Error).message); }
  }, []);
  usePoll(load, POLL_MS);
  if (!view) return <Panel title="Access" icon={KeySquare}><Empty>{error ?? 'loading'}</Empty></Panel>;
  return (
    <div data-slot="access" className="space-y-3">
      <Panel title="Access" icon={KeySquare}>
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            Before a credential is given, the hopper asks OpenFGA whether the requester — a job, a box or a user — reaches a template
            approved for that operation on that asset. Revoking an approval denies the next request; nothing already given is widened.
          </p>
          <Status status={view.status} />
        </div>
      </Panel>
      <Approvals view={view} onChanged={setView} />
      <Matrix view={view} />
      <Check />
      <Panel title="Recent decisions" icon={KeySquare} count={view.decisions.length} list>
        {view.decisions.length === 0 ? <Empty>no decisions yet</Empty> : (
          <ul>
            {view.decisions.map((d) => (
              <li key={d.id} data-decision={d.id} data-allowed={String(d.allowed)} className="space-y-0.5 border-b py-2 text-xs last:border-b-0">
                <span className="num font-mono text-muted-foreground" title={d.at}>{clock(d.at)}</span>
                {' '}<span className="text-muted-foreground">{d.trial ? `tried by ${d.trial.by}` : d.requester ? requesterText(d.requester) : ''}</span>
                <DecisionLine d={d} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Model key={view.model.version} view={view} onChanged={setView} />
    </div>
  );
}
