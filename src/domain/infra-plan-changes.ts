// The changes of an infra plan (issue #870, design.md "Infra plans: the summary and the MAP tag check"): what each
// resource of the plan has done to it, read from what the tool wrote — `terraform show -json` of the plan file, a
// `helm diff`, an `argocd app diff`. The summary (infra-plan-summary.ts) is made from these. Pure.
import type { PlanTool } from './infra-plans.ts';

export const CHANGE_ACTIONS = ['create', 'update', 'replace', 'delete'] as const;
export type ChangeAction = (typeof CHANGE_ACTIONS)[number];

/** One resource the plan changes: its address in the tool's words, its type (a terraform type, a Kubernetes kind), how. */
export interface PlannedChange {
  address: string;
  type: string;
  action: ChangeAction;
  /** A terraform resource's `Environment` tag after the change, when it has one. */
  envTag?: string;
  /** A new AWS resource that takes tags, without the MAP tag (`MAP_TAG`). */
  untagged?: true;
}

/** The tag every new AWS resource carries (AWS Migration Acceleration Program); a new one without it fails the plan. */
export const MAP_TAG = { key: 'map-migrated', value: 'migXWT2TUR4TJ' } as const;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** How terraform's `actions` change a resource; undefined for a no-op or a read. */
function actionOf(actions: unknown): ChangeAction | undefined {
  if (!Array.isArray(actions)) return undefined;
  const a = actions.join(',');
  if (a === 'create' || a === 'update' || a === 'delete') return a;
  if (a === 'delete,create' || a === 'create,delete') return 'replace';
  return undefined;
}

const tagsOf = (after: Record<string, unknown>): Record<string, unknown>[] => ['tags_all', 'tags'].map((k) => after[k]).filter(isObject);

/** A new AWS resource that takes tags (its plan has `tags` or `tags_all`) and has not the MAP tag in either. */
function untagged(provider: unknown, action: ChangeAction, after: unknown): boolean {
  if (action !== 'create' || typeof provider !== 'string' || !/(^|\/)aws$/.test(provider) || !isObject(after)) return false;
  if (!('tags' in after) && !('tags_all' in after)) return false;
  return !tagsOf(after).some((t) => t[MAP_TAG.key] === MAP_TAG.value);
}

function envTagOf(after: unknown): string | undefined {
  if (!isObject(after)) return undefined;
  for (const t of tagsOf(after)) {
    const v = t.Environment ?? t.environment ?? t.env ?? t.Env;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function terraformChanges(json: string): PlannedChange[] | string {
  let plan: unknown;
  try {
    plan = JSON.parse(json);
  } catch (e) {
    return `json is not JSON: ${(e as Error).message}`;
  }
  // A plan has planned_values; the JSON of a state has not. A plan that changes nothing can leave resource_changes out.
  if (!isObject(plan) || !('format_version' in plan) || !isObject(plan.planned_values) || (plan.resource_changes !== undefined && !Array.isArray(plan.resource_changes))) {
    return 'json must be terraform show -json of the plan file: an object with format_version, planned_values and resource_changes';
  }
  const out: PlannedChange[] = [];
  for (const rc of (plan.resource_changes ?? []) as unknown[]) {
    if (!isObject(rc) || rc.mode === 'data' || !isObject(rc.change) || typeof rc.address !== 'string' || typeof rc.type !== 'string') continue;
    const action = actionOf(rc.change.actions);
    if (!action) continue;
    const env = envTagOf(rc.change.after);
    out.push({
      address: rc.address, type: rc.type, action, ...(env ? { envTag: env } : {}),
      ...(untagged(rc.provider_name, action, rc.change.after) ? { untagged: true as const } : {}),
    });
  }
  return out;
}

/** `helm diff`: `<namespace>, <name>, <Kind> (<group>) has changed:` / `has been added:` / `has been removed:`. */
const HELM = /^(\S+), (\S+), (\S+) \([^)]*\) has (changed|been added|been removed):?\s*$/;
const HELM_ACTION = { changed: 'update', 'been added': 'create', 'been removed': 'delete' } as const;

function helmChanges(text: string): PlannedChange[] {
  return text.split('\n').flatMap((line) => {
    const m = HELM.exec(line);
    return m ? [{ address: `${m[1]}/${m[3]}/${m[2]}`, type: m[3]!, action: HELM_ACTION[m[4] as keyof typeof HELM_ACTION] }] : [];
  });
}

/** `argocd app diff`: `===== <group>/<Kind> <namespace>/<name> ======`, then `<` lines (live) and `>` lines (desired). */
const ARGO = /^===== (\S*)\/(\S+) (\S*)\/(\S+) ======\s*$/;

function argoChanges(text: string): PlannedChange[] {
  const out: (PlannedChange & { live: boolean; desired: boolean })[] = [];
  for (const line of text.split('\n')) {
    const m = ARGO.exec(line);
    const last = out.at(-1);
    if (m) out.push({ address: `${m[3]}/${m[2]}/${m[4]}`, type: m[2]!, action: 'update', live: false, desired: false });
    else if (last && line.startsWith('<')) last.live = true;
    else if (last && line.startsWith('>')) last.desired = true;
  }
  return out.map(({ live, desired, ...c }) => ({ ...c, action: live && !desired ? 'delete' : desired && !live ? 'create' : 'update' }));
}

/** The changes a plan makes, or why its words cannot be read. Terraform needs `json`; a diff is read from its text. */
export function changesOf(tool: PlanTool, text: string, json: string | undefined): PlannedChange[] | string {
  if (tool !== 'terraform') {
    if (json !== undefined) return 'json is for a terraform plan only: terraform show -json of the plan file';
    return tool === 'helm' ? helmChanges(text) : argoChanges(text);
  }
  if (json === undefined || !json.trim()) return 'json must hold terraform show -json of the plan file: the hopper reads the plan\'s changes from it';
  return terraformChanges(json);
}
