// The permission matrix (issue #559), pure: who may do what on which asset, read from GET /api/access. Rows are the
// templates, each followed by its machines, or the live jobs; a machine or a job may do what its template is approved
// for. Columns are the assets an approval names or a template waits on, grouped by kind. A cell holds the approved
// operations and, apart, those that wait for approval (a template's declared profile not approved yet, issue #584).
import type { AccessView, Approval, Asset, AssetKind, Operation, OperationProfile, TemplateRadius } from './wire.ts';

export const ALL = 'all';
const OPERATIONS: Operation[] = ['read', 'write', 'sync', 'apply'];
const ASSET_KINDS: AssetKind[] = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'];

/** `templates`: each template, then its machines; `jobs`: the live jobs. */
export type MatrixRows = 'templates' | 'jobs';

export interface MatrixFilter {
  rows: MatrixRows;
  kind: AssetKind | typeof ALL;
  operation: Operation | typeof ALL;
  /** Part of a template, machine, job or user name; empty: every row. */
  search: string;
  /** Only the rows with an approved operation in a column shown. */
  onlyWithAccess: boolean;
}

export interface MatrixRow {
  /** `template:<name>`, `machine:<user>/<machine>`, `job:<user>/<job>`. */
  key: string;
  kind: 'template' | 'machine' | 'job';
  label: string;
  template: string;
  user?: string;
  machine?: string;
  job?: string;
  status?: string;
  /** A template row's blast radius. */
  radius?: TemplateRadius;
}

export interface MatrixColumn { key: string; asset: Asset }
export interface MatrixCell { approved: Approval[]; pending: OperationProfile[] }
export interface Matrix {
  rows: MatrixRow[];
  groups: { kind: AssetKind; columns: MatrixColumn[] }[];
  cell(row: MatrixRow, column: MatrixColumn): MatrixCell;
}

export const assetKey = (a: Asset): string => `${a.kind}/${a.name}`;
const byOperation = (a: Operation, b: Operation) => OPERATIONS.indexOf(a) - OPERATIONS.indexOf(b);

/** How a row reaches its template, in words: a job runs on its machine, a machine joined as a box of the template. */
export function rowSteps(row: MatrixRow): string[] {
  const steps: string[] = [];
  if (row.kind === 'job') steps.push(`job ${row.job} runs on machine ${row.machine}`);
  if (row.kind !== 'template') steps.push(`machine ${row.machine} joined as a box of template ${row.template}`);
  return steps;
}

function allRows(view: AccessView, rows: MatrixRows): MatrixRow[] {
  if (rows === 'jobs') {
    return view.holders.jobs.map((j) => ({ key: `job:${j.user}/${j.job}`, kind: 'job', label: `job ${j.job}`, template: j.template, user: j.user, machine: j.machine, job: j.job, status: j.status }));
  }
  const names = [...new Set([...view.templates.map((t) => t.template), ...view.holders.machines.map((m) => m.template)])].sort();
  return names.flatMap((template): MatrixRow[] => {
    const radius = view.templates.find((t) => t.template === template)?.radius;
    return [
      { key: `template:${template}`, kind: 'template', label: template, template, ...(radius ? { radius } : {}) },
      ...view.holders.machines.filter((m) => m.template === template)
        .map((m): MatrixRow => ({ key: `machine:${m.user}/${m.machine}`, kind: 'machine', label: m.machine, template, user: m.user, machine: m.machine })),
    ];
  });
}

export function permissionMatrix(view: AccessView, f: MatrixFilter): Matrix {
  const shows = (op: Operation) => f.operation === ALL || f.operation === op;
  const approvals = new Map<string, Approval[]>();
  const pending = new Map<string, OperationProfile[]>();
  const assets = new Map<string, Asset>();
  for (const t of view.templates) {
    for (const a of t.approvals.filter((x) => shows(x.profile.operation))) {
      approvals.set(t.template, [...approvals.get(t.template) ?? [], a]);
      assets.set(assetKey(a.profile.asset), a.profile.asset);
    }
    for (const p of t.radius.profiles.filter((x) => !x.approved && shows(x.profile.operation))) {
      pending.set(t.template, [...pending.get(t.template) ?? [], p.profile]);
      assets.set(assetKey(p.profile.asset), p.profile.asset);
    }
  }
  const groups = ASSET_KINDS.filter((k) => f.kind === ALL || f.kind === k).map((kind) => ({
    kind,
    columns: [...assets.values()].filter((a) => a.kind === kind).sort((a, b) => a.name.localeCompare(b.name)).map((asset) => ({ key: assetKey(asset), asset })),
  })).filter((g) => g.columns.length > 0);
  const shown = new Set(groups.flatMap((g) => g.columns.map((c) => c.key)));

  const cell = (row: MatrixRow, column: MatrixColumn): MatrixCell => ({
    approved: (approvals.get(row.template) ?? []).filter((a) => assetKey(a.profile.asset) === column.key).sort((a, b) => byOperation(a.profile.operation, b.profile.operation)),
    pending: (pending.get(row.template) ?? []).filter((p) => assetKey(p.asset) === column.key).sort((a, b) => byOperation(a.operation, b.operation)),
  });
  const needle = f.search.trim().toLowerCase();
  const rows = allRows(view, f.rows)
    .filter((r) => needle === '' || [r.label, r.template, r.machine, r.job, r.user].some((s) => s?.toLowerCase().includes(needle)))
    .filter((r) => !f.onlyWithAccess || (approvals.get(r.template) ?? []).some((a) => shown.has(assetKey(a.profile.asset))));
  return { rows, groups, cell };
}
