// The permission matrix (issue #559), pure: who may do what on which asset, read from GET /api/access. Rows are the
// templates, each followed by its boxes, then the users — or the live jobs; the rows besides the templates are the
// requesters (issue #581), each with the profiles it reaches and the path. Columns are the assets an approval names or a
// template waits on, grouped by kind. A cell holds what the row may do, each with its path and the approval behind it,
// and apart what the row's template waits for (a declared profile not approved yet, issue #584).
import { requesterKey, requesterText } from './access.ts';
import type { AccessView, Approval, Asset, AssetKind, Operation, OperationProfile, RelationshipTuple, Requester, TemplateRadius } from './wire.ts';

export const ALL = 'all';
const OPERATIONS: Operation[] = ['read', 'write', 'sync', 'apply'];
const ASSET_KINDS: AssetKind[] = ['cluster', 'namespace', 'argocd-app', 'terraform-workspace', 'aws-account', 'aws-role'];

/** `requesters`: each template, then its boxes, then the users; `jobs`: the live jobs. */
export type MatrixRows = 'requesters' | 'jobs';

export interface MatrixFilter {
  rows: MatrixRows;
  kind: AssetKind | typeof ALL;
  operation: Operation | typeof ALL;
  /** Part of a template, machine, job or user name; empty: every row. */
  search: string;
  /** Only the rows that may do something in a column shown. */
  onlyWithAccess: boolean;
}

export interface MatrixRow {
  /** `template:<name>`, else the requester's key (`user:<user>`, `job:<user>/<job>`, `machine:<user>/<machine>`). */
  key: string;
  kind: 'template' | Requester['kind'];
  label: string;
  requester?: Requester;
  /** The template it is, or runs as now. */
  template?: string;
  machine?: string;
  /** A template row's blast radius. */
  radius?: TemplateRadius;
  /** What it may do: each operation profile with the path to it. */
  grants: { profile: OperationProfile; path: RelationshipTuple[] }[];
}

export interface MatrixColumn { key: string; asset: Asset }
/** One operation the row may do on the asset: why (the path), and the approval a revoke ends, when the path names one. */
export interface MatrixEntry { operation: Operation; path: RelationshipTuple[]; approval?: Approval }
export interface MatrixCell { entries: MatrixEntry[]; pending: OperationProfile[] }
export interface Matrix {
  rows: MatrixRow[];
  groups: { kind: AssetKind; columns: MatrixColumn[] }[];
  cell(row: MatrixRow, column: MatrixColumn): MatrixCell;
}

export const assetKey = (a: Asset): string => `${a.kind}/${a.name}`;
const byOperation = (a: Operation, b: Operation) => OPERATIONS.indexOf(a) - OPERATIONS.indexOf(b);
const templateOnPath = (path: readonly RelationshipTuple[]): string | undefined =>
  path.find((t) => t.relation === 'approved_for')?.subject.replace(/^template:/, '');

function allRows(view: AccessView, rows: MatrixRows): MatrixRow[] {
  const of = (r: AccessView['requesters'][number]): MatrixRow => ({
    key: requesterKey(r.requester), kind: r.requester.kind, label: requesterText(r.requester), requester: r.requester,
    ...(r.template === undefined ? {} : { template: r.template }), ...(r.machine === undefined ? {} : { machine: r.machine }), grants: r.grants,
  });
  if (rows === 'jobs') return view.requesters.filter((r) => r.requester.kind === 'job').map(of);
  const boxes = view.requesters.filter((r) => r.requester.kind === 'machine');
  const names = [...new Set([...view.templates.map((t) => t.template), ...boxes.flatMap((b) => (b.template ? [b.template] : []))])].sort();
  return [
    ...names.flatMap((template): MatrixRow[] => {
      const t = view.templates.find((x) => x.template === template);
      return [
        { key: `template:${template}`, kind: 'template', label: template, template, ...(t ? { radius: t.radius } : {}), grants: (t?.approvals ?? []).map((a) => ({ profile: a.profile, path: a.chain })) },
        ...boxes.filter((b) => b.template === template).map(of),
      ];
    }),
    ...view.requesters.filter((r) => r.requester.kind === 'user').map(of),
  ];
}

export function permissionMatrix(view: AccessView, f: MatrixFilter): Matrix {
  const shows = (op: Operation) => f.operation === ALL || f.operation === op;
  const assets = new Map<string, Asset>();
  for (const t of view.templates) {
    for (const a of t.approvals) if (shows(a.profile.operation)) assets.set(assetKey(a.profile.asset), a.profile.asset);
    for (const p of t.radius.profiles) if (!p.approved && shows(p.profile.operation)) assets.set(assetKey(p.profile.asset), p.profile.asset);
  }
  const groups = ASSET_KINDS.filter((k) => f.kind === ALL || f.kind === k).map((kind) => ({
    kind,
    columns: [...assets.values()].filter((a) => a.kind === kind).sort((a, b) => a.name.localeCompare(b.name)).map((asset) => ({ key: assetKey(asset), asset })),
  })).filter((g) => g.columns.length > 0);
  const shown = new Set(groups.flatMap((g) => g.columns.map((c) => c.key)));

  const approvalOf = (path: RelationshipTuple[], p: OperationProfile): Approval | undefined => {
    const template = templateOnPath(path);
    return view.templates.find((t) => t.template === template)?.approvals
      .find((a) => a.profile.operation === p.operation && assetKey(a.profile.asset) === assetKey(p.asset));
  };
  const cell = (row: MatrixRow, column: MatrixColumn): MatrixCell => ({
    entries: row.grants.filter((g) => assetKey(g.profile.asset) === column.key && shows(g.profile.operation))
      .map((g): MatrixEntry => {
        const approval = approvalOf(g.path, g.profile);
        return { operation: g.profile.operation, path: g.path, ...(approval ? { approval } : {}) };
      }).sort((a, b) => byOperation(a.operation, b.operation)),
    pending: (view.templates.find((t) => t.template === row.template)?.radius.profiles ?? [])
      .filter((p) => !p.approved && assetKey(p.profile.asset) === column.key && shows(p.profile.operation))
      .map((p) => p.profile).sort((a, b) => byOperation(a.operation, b.operation)),
  });
  const needle = f.search.trim().toLowerCase();
  const rows = allRows(view, f.rows)
    .filter((r) => needle === '' || [r.label, r.template, r.machine, r.requester?.userId].some((s) => s?.toLowerCase().includes(needle)))
    .filter((r) => !f.onlyWithAccess || r.grants.some((g) => shows(g.profile.operation) && shown.has(assetKey(g.profile.asset))));
  return { rows, groups, cell };
}
