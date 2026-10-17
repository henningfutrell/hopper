// The ready-made collector's pure half (issue #871 part 3, design.md "Out-of-band changes"): what the read-only tools
// print — Argo CD's and Flux's objects, `terraform plan -detailed-exitcode`, CloudTrail's lookup-events, the Kubernetes
// audit log — as signals. It keeps writes and drift and classifies no action: the hopper's rule judges each signal.
// `scripts/out-of-band-collector.ts` runs the tools and reports. Pure.
import { createHash } from 'node:crypto';
import { DETAIL_MAX, type Signal } from './out-of-band.ts';

const LINE_MAX = 300;
const KEY_MAX = 200;

/** One line, at most `max` characters: a long one keeps its start and a hash of the whole, so it stays its own. */
function line(s: string, max = LINE_MAX): string {
  const one = s.replace(/[\r\n]+/g, ' ').trim() || '-';
  if (one.length <= max) return one;
  const hash = createHash('sha256').update(one).digest('hex').slice(0, 12);
  return `${one.slice(0, max - 14)}…#${hash}`;
}

/** At most DETAIL_MAX bytes: a long one keeps its end, where a plan's summary and an error are. */
function detail(s: string): string | undefined {
  if (!s.trim()) return undefined;
  if (Buffer.byteLength(s) <= DETAIL_MAX) return s;
  const tail = Buffer.from(s).subarray(-(DETAIL_MAX - 64)).toString('utf8').replace(/^�+/, '');
  return `…(cut)\n${tail}`;
}

function signal(s: Signal): Signal {
  const out: Signal = { source: s.source, key: line(s.key, KEY_MAX), target: line(s.target), what: line(s.what), at: s.at };
  if (s.who !== undefined) out.who = line(s.who);
  const d = s.detail === undefined ? undefined : detail(s.detail);
  if (d !== undefined) out.detail = d;
  return out;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const itemsOf = (list: unknown): Obj[] => arr(obj(list).items).map(obj);
const nameOf = (item: Obj): string => {
  const m = obj(item.metadata);
  return `${str(m.namespace) ?? '-'}/${str(m.name) ?? '-'}`;
};

/**
 * The label that marks an Argo CD application as gated (issue #959): it syncs only through an approved plan, so Argo CD
 * must not sync it by itself.
 */
export const ARGO_PLAN_GATE_LABEL = 'io.hopper.plan-gate';

/** A gated application whose automated sync is on: each sync Argo CD makes by itself skips the plan gate. */
function autoSyncSignal(app: Obj, at: string): Signal[] {
  if (str(obj(obj(app.metadata).labels)[ARGO_PLAN_GATE_LABEL]) !== 'true' || !('automated' in obj(obj(app.spec).syncPolicy))) return [];
  const name = nameOf(app);
  return [signal({
    source: 'gitops', key: `argocd:${name}:auto-sync`, target: `Argo CD application ${name}`, what: 'AutoSyncOnGatedApp', at,
    detail: `the application is labelled ${ARGO_PLAN_GATE_LABEL}=true, but Argo CD syncs it by itself: turn off its automated sync, so it syncs only through an approved plan`,
  })];
}

/**
 * `kubectl get applications.argoproj.io -A -o json`: each application out of sync is drift, and so is a gated one that
 * syncs by itself.
 */
export function argoSignals(list: unknown, at: string): Signal[] {
  return itemsOf(list).flatMap((app) => {
    const status = obj(app.status);
    const sync = obj(status.sync);
    const auto = autoSyncSignal(app, at);
    if (sync.status !== 'OutOfSync') return auto;
    const name = nameOf(app);
    const resources = arr(status.resources).map(obj).filter((r) => r.status === 'OutOfSync')
      .map((r) => `${str(r.kind) ?? '-'} ${str(r.namespace) ?? '-'}/${str(r.name) ?? '-'} OutOfSync`);
    const text = [str(sync.revision) && `revision ${str(sync.revision)}`, ...resources].filter(Boolean).join('\n');
    return [signal({ source: 'gitops', key: `argocd:${name}`, target: `Argo CD application ${name}`, what: 'OutOfSync', at, detail: text }), ...auto];
  });
}

/**
 * `kubectl get kustomizations.kustomize.toolkit.fluxcd.io,helmreleases.helm.toolkit.fluxcd.io -A -o json`: an object
 * that is not ready does not hold what git says; a suspended one no longer puts it back. Each is drift, by its reason.
 */
export function fluxSignals(list: unknown, at: string): Signal[] {
  return itemsOf(list).flatMap((item) => {
    const kind = str(item.kind) ?? 'object';
    const name = nameOf(item);
    const base = { source: 'gitops' as const, key: `flux:${kind}/${name}`, target: `Flux ${kind} ${name}`, at };
    if (obj(item.spec).suspend === true) return [signal({ ...base, what: 'Suspended' })];
    const ready = arr(obj(item.status).conditions).map(obj).find((c) => c.type === 'Ready');
    if (!ready || ready.status === 'True') return [];
    return [signal({ ...base, what: str(ready.reason) ?? `Ready ${str(ready.status) ?? 'unknown'}`, detail: str(ready.message) ?? '' })];
  });
}

/**
 * `terraform plan -detailed-exitcode` on unchanged code: exit code 2 (a plan that is not empty) is drift, 0 is none, and
 * any other is a failed plan, thrown with its text: an unread plan is no answer.
 */
export function terraformSignal(dir: string, exitCode: number, text: string, at: string): Signal | undefined {
  if (exitCode === 0) return undefined;
  if (exitCode !== 2) throw new Error(`terraform ${dir}: plan failed (exit code ${exitCode}):\n${text.trim()}`);
  const summary = /^Plan: .*$/m.exec(text)?.[0].trim() ?? 'plan not empty';
  return signal({ source: 'terraform-plan', key: `terraform:${dir}`, target: `terraform ${dir}`, what: summary, at, detail: text });
}

/**
 * `aws cloudtrail lookup-events --lookup-attributes AttributeKey=ReadOnly,AttributeValue=false`: each write, by the
 * principal its record names (`userIdentity.arn`, else the user name). A read is none.
 */
export function cloudTrailSignals(out: unknown): Signal[] {
  return arr(obj(out).Events).map(obj).flatMap((e) => {
    let record: Obj = {};
    try { record = obj(JSON.parse(str(e.CloudTrailEvent) ?? '{}')); } catch { /* the record is kept as text */ }
    if (e.ReadOnly === 'true' || record.readOnly === true) return [];
    const id = str(e.EventId) ?? str(record.eventID);
    const at = str(e.EventTime) ?? str(record.eventTime);
    if (!id || !at) return [];
    const service = (str(e.EventSource) ?? str(record.eventSource) ?? 'aws').replace(/\.amazonaws\.com$/, '');
    const resource = arr(e.Resources).map(obj).map((r) => str(r.ResourceName)).find(Boolean);
    const who = str(obj(record.userIdentity).arn) ?? str(e.Username) ?? 'unknown';
    return [signal({
      source: 'cloudtrail', key: id, target: resource ?? str(e.EventSource) ?? service, what: `${service}:${str(e.EventName) ?? 'unknown'}`,
      who, at, detail: str(e.CloudTrailEvent) ?? '',
    })];
  });
}

const WRITES = new Set(['create', 'update', 'patch', 'delete', 'deletecollection']);

/**
 * The Kubernetes audit log, one JSON event a line (audit.k8s.io/v1): each write that went through (its response below
 * 400), once (at `ResponseComplete`), at or after `since`. `skipped` counts the lines that are no JSON.
 */
export function kubeAuditSignals(text: string, since: string): { signals: Signal[]; skipped: number } {
  const from = Date.parse(since);
  let skipped = 0;
  const signals: Signal[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let e: Obj;
    try { e = obj(JSON.parse(raw)); } catch { skipped++; continue; }
    const verb = str(e.verb);
    const code = obj(e.responseStatus).code;
    const at = str(e.stageTimestamp) ?? str(e.requestReceivedTimestamp);
    const id = str(e.auditID);
    if (!verb || !WRITES.has(verb) || e.stage !== 'ResponseComplete' || !id || !at) continue;
    if (typeof code === 'number' && code >= 400) continue;
    if (!(Date.parse(at) >= from)) continue;
    const ref = obj(e.objectRef);
    const resource = str(ref.resource) ?? 'unknown';
    const target = [str(ref.namespace), resource, str(ref.name)].filter(Boolean).join('/');
    const sub = str(ref.subresource);
    signals.push(signal({
      source: 'kube-audit', key: id, target, what: `${verb} ${resource}${sub ? `/${sub}` : ''}`,
      who: str(obj(e.user).username) ?? 'unknown', at, detail: raw,
    }));
  }
  return { signals, skipped };
}
