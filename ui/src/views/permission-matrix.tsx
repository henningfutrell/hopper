// Settings → Permission matrix (issue #559): who may do what on which asset, from GET /api/access. Rows are the
// templates (with their blast radius, issue #584) each followed by its boxes, then the users — or the live jobs: the
// requesters of issue #581. Columns are the assets, grouped by kind; each cell the approved operations, and apart those
// that wait for approval. A click on a cell says why — the relationship path, who approved it and when — and revokes.
// Filters keep it readable with dozens of rows and columns; headers and the first column stay in place on scroll. The
// instance admin's alone, as Settings → Access.
import { Grid3x3 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { Confirm } from '@/components/confirm';
import { Empty, Panel } from '@/components/panel';
import { FIELD } from '@/components/plugin-form';
import { StatusBadge } from '@/components/status';
import { TemplateRadiusBadge } from '@/components/template-radius';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { usePoll } from '@/hooks/use-poll';
import { get, post } from '@/lib/api';
import { cn } from '@/lib/utils';
import { chainText } from '@/model/access';
import { clock } from '@/model/format';
import { ALL, permissionMatrix, type MatrixColumn, type MatrixFilter, type MatrixRow, type MatrixRows } from '@/model/permission-matrix';
import type { AccessView, Approval, AssetKind, Operation } from '@/model/wire';

const POLL_MS = 10_000;
const OPERATIONS: Operation[] = ['read', 'write', 'sync', 'apply'];
const ASSET_KINDS: AssetKind[] = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'];
const ROW_VIEWS: [MatrixRows, string][] = [['requesters', 'Templates, boxes and users'], ['jobs', 'Jobs']];

const profileText = (a: Approval) => `${a.profile.operation} on ${a.profile.asset.kind} ${a.profile.asset.name}`;

/** Where the row runs: a job on its machine as its template, a box of its template; and whose it is. */
function whereText(row: MatrixRow): string {
  const user = row.requester ? ` · ${row.requester.userId}` : '';
  if (row.kind === 'job') return `${row.template ?? 'no template'} on ${row.machine ?? 'no machine yet'}${user}`;
  if (row.kind === 'machine') return `box${user}`;
  return '';
}

function RowHead({ row }: { row: MatrixRow }) {
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5', row.kind === 'machine' && 'pl-4')}>
      <span className="truncate font-mono">{row.kind === 'template' || row.kind === 'machine' ? row.label.replace(/^machine /, '') : row.label}</span>
      {row.radius && <TemplateRadiusBadge radius={row.radius} />}
      {whereText(row) && <span className="text-[11px] text-muted-foreground">{whereText(row)}</span>}
    </div>
  );
}

type Picked = { row: MatrixRow; column: MatrixColumn };

function Why({ picked, view, onClose, onChanged }: { picked: Picked | undefined; view: AccessView; onClose: () => void; onChanged: (v: AccessView) => void }) {
  const [busy, setBusy] = useState(false);
  const matrix = permissionMatrix(view, { rows: picked?.row.kind === 'job' ? 'jobs' : 'requesters', kind: ALL, operation: ALL, search: '', onlyWithAccess: false });
  const row = picked && matrix.rows.find((r) => r.key === picked.row.key);
  const cell = picked ? matrix.cell(row ?? { ...picked.row, grants: [] }, picked.column) : undefined;
  const revoke = async (a: Approval) => {
    setBusy(true);
    try {
      onChanged(await post<AccessView>('/ui/api/access', { action: 'revoke', approval: a.id }));
      toast.success(`Revoked: ${a.template} may no longer ${profileText(a)}`);
    } catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  };
  return (
    <Sheet open={picked !== undefined} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {picked && cell && <div data-slot="matrix-why" className="space-y-3 p-4 text-sm">
          <SheetHeader className="p-0">
            <SheetTitle className="pr-8 font-mono break-words">{picked.row.label} → {picked.column.asset.kind} {picked.column.asset.name}</SheetTitle>
            <SheetDescription>Why this {picked.row.kind === 'machine' ? 'box' : picked.row.kind} may do each operation here, and who approved it.</SheetDescription>
          </SheetHeader>
          {cell.entries.length === 0 && cell.pending.length === 0 && <p className="text-muted-foreground">Nothing: no approval reaches this asset from here.</p>}
          <ul className="space-y-2">
            {cell.entries.map((e) => (
              <li key={e.operation} data-op={e.operation} {...(e.approval ? { 'data-approval': e.approval.id } : {})} className="space-y-1 rounded-lg border p-2">
                <div className="flex items-center gap-2">
                  <StatusBadge status="approved" tone="ok" label={e.operation} />
                  {e.approval && <Confirm title={`Revoke ${e.approval.template}: ${profileText(e.approval)}?`} action="Revoke" onConfirm={() => void revoke(e.approval!)}
                    description={`Every box, job and user that reaches ${e.approval.template} gets no new ${e.operation} credential for ${e.approval.profile.asset.kind} ${e.approval.profile.asset.name} from the next request. Approving it again takes a new approval.`}>
                    <Button size="xs" variant="outline" className="ml-auto" disabled={busy}>Revoke</Button>
                  </Confirm>}
                </div>
                <div className="text-xs break-words">{chainText(e.path)}</div>
                {e.approval && <div className="text-xs text-muted-foreground">approved by {e.approval.approvedBy} at {clock(e.approval.approvedAt)}</div>}
              </li>
            ))}
            {cell.pending.map((p) => (
              <li key={p.operation} data-pending={p.operation} className="rounded-lg border border-dashed p-2 text-xs text-warn">
                {p.operation}: waits for approval on Settings → Vault
              </li>
            ))}
          </ul>
        </div>}
      </SheetContent>
    </Sheet>
  );
}

function Filters({ filter, onChange }: { filter: MatrixFilter; onChange: (f: MatrixFilter) => void }) {
  return (
    <div className="flex flex-wrap items-end gap-2 text-sm">
      <div className="flex rounded-lg border p-0.5" role="group" aria-label="Rows">
        {ROW_VIEWS.map(([rows, label]) => (
          <Button key={rows} size="xs" variant={filter.rows === rows ? 'default' : 'ghost'} aria-pressed={filter.rows === rows} onClick={() => onChange({ ...filter, rows })}>{label}</Button>
        ))}
      </div>
      <label className="grid gap-1"><span className="text-xs text-muted-foreground">Asset kind</span>
        <select name="kind" className={`${FIELD} w-44`} value={filter.kind} onChange={(e) => onChange({ ...filter, kind: e.target.value as MatrixFilter['kind'] })}>
          <option value={ALL}>all</option>{ASSET_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
        </select></label>
      <label className="grid gap-1"><span className="text-xs text-muted-foreground">Operation</span>
        <select name="operation" className={`${FIELD} w-28`} value={filter.operation} onChange={(e) => onChange({ ...filter, operation: e.target.value as MatrixFilter['operation'] })}>
          <option value={ALL}>all</option>{OPERATIONS.map((o) => <option key={o} value={o}>{o}</option>)}
        </select></label>
      <label className="grid gap-1"><span className="text-xs text-muted-foreground">Name</span>
        <Input name="search" className="h-8 w-44" value={filter.search} placeholder="template, machine, job" onChange={(e) => onChange({ ...filter, search: e.target.value })} /></label>
      <label className="flex h-8 items-center gap-2 text-xs">
        <input type="checkbox" name="only-with-access" checked={filter.onlyWithAccess} onChange={(e) => onChange({ ...filter, onlyWithAccess: e.target.checked })} />
        Only rows with access
      </label>
    </div>
  );
}

export function PermissionMatrix() {
  const [view, setView] = useState<AccessView | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [filter, setFilter] = useState<MatrixFilter>({ rows: 'requesters', kind: ALL, operation: ALL, search: '', onlyWithAccess: false });
  const [picked, setPicked] = useState<Picked | undefined>();
  const load = useCallback(async () => {
    try { setView(await get<AccessView>('/api/access')); setError(undefined); } catch (e) { setError((e as Error).message); }
  }, []);
  usePoll(load, POLL_MS);
  if (!view) return <Panel title="Permission matrix" icon={Grid3x3}><Empty>{error ?? 'loading'}</Empty></Panel>;
  const m = permissionMatrix(view, filter);
  const columns = m.groups.flatMap((g) => g.columns);
  return (
    <div data-slot="permission-matrix" data-loaded="true" className="space-y-3">
      <Panel title="Permission matrix" icon={Grid3x3} count={`${m.rows.length} × ${columns.length}`}>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            What each template, its boxes, each user and each live job may do on each asset: the hopper's reading of its own rows. <span className="text-ok">Approved</span> operations are
            solid; ones that <span className="text-warn">wait for approval</span> are dashed. Click a cell to see why and to revoke.
          </p>
          <Filters filter={filter} onChange={setFilter} />
          {columns.length === 0 ? <Empty>No asset is approved or waits for approval{filter.kind !== ALL || filter.operation !== ALL ? ' for this filter' : ''}.</Empty>
            : m.rows.length === 0 ? <Empty>No row matches the filter.</Empty> : (
              <div className="max-h-[70vh] overflow-auto rounded-lg border">
                <table className="border-separate border-spacing-0 text-xs">
                  <thead>
                    <tr>
                      <th rowSpan={2} className="sticky top-0 left-0 z-30 min-w-48 border-r border-b bg-card px-2 py-1 text-left font-medium">{filter.rows === 'jobs' ? 'Job' : 'Template, box, user'}</th>
                      {m.groups.map((g) => <th key={g.kind} data-kind={g.kind} colSpan={g.columns.length} className="sticky top-0 z-20 h-7 border-b border-l bg-card px-2 text-left font-medium">{g.kind}</th>)}
                    </tr>
                    <tr>
                      {columns.map((c) => <th key={c.key} title={c.key} className="sticky top-7 z-20 max-w-40 truncate border-b border-l bg-card px-2 py-1 text-left font-mono font-normal">{c.asset.name}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {m.rows.map((row) => (
                      <tr key={row.key} data-row={row.key} className="hover:bg-muted/40">
                        <th scope="row" className="sticky left-0 z-10 border-r border-b bg-card px-2 py-1 text-left font-normal"><RowHead row={row} /></th>
                        {columns.map((c) => {
                          const cell = m.cell(row, c);
                          return (
                            <td key={c.key} data-asset={c.key} className="border-b border-l p-0">
                              <button type="button" className="flex min-h-8 w-full min-w-20 flex-wrap items-center gap-1 px-2 py-1 text-left hover:bg-muted/60"
                                aria-label={`${row.label} on ${c.asset.kind} ${c.asset.name}`} onClick={() => setPicked({ row, column: c })}>
                                {cell.entries.map((e) => <span key={e.operation} data-op={e.operation} data-state="approved" className="rounded border border-ok/30 bg-ok/10 px-1 text-ok">{e.operation}</span>)}
                                {cell.pending.map((p) => <span key={p.operation} data-op={p.operation} data-state="pending" title="waits for approval" className="rounded border border-dashed border-warn/50 px-1 text-warn">{p.operation}</span>)}
                              </button>
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
      <Why picked={picked} view={view} onClose={() => setPicked(undefined)} onChanged={setView} />
    </div>
  );
}
