// Priority of an issue: its Projects (v2) item when the repo has a project configured and the
// item gives a value, else the highest priority label, else defaultPriority. The project wins.

import type { GitHubApi, GitHubIssue, GitHubProjectItem } from './api.ts';
import type { GitHubProjectConfig, GitHubSourceConfig } from '../config.ts';

export interface ProjectView {
  /** e.g. "owner/projects/3" */
  label: string;
  cfg: GitHubProjectConfig;
  byUrl: Map<string, GitHubProjectItem>;
  /** Rank (0 = top) among eligible items only. */
  rank: Map<string, number>;
}

export interface Priority {
  priority: number;
  reason: string;
  /** For the context block: "<project> · Priority=P1", or "none". */
  projectItem: string;
}

/** Read each configured project once. A failing project is an error for its repos, never fatal. */
export async function readProjects(api: GitHubApi, config: GitHubSourceConfig, issues: GitHubIssue[]):
Promise<{ views: Map<string, ProjectView>; errors: Record<string, string> }> {
  const eligible = new Set(issues.map((i) => i.url));
  const repos = new Set(issues.map((i) => i.repo));
  const cache = new Map<string, Promise<GitHubProjectItem[]>>();
  const views = new Map<string, ProjectView>();
  const errors: Record<string, string> = {};
  for (const [repo, cfg] of Object.entries(config.projects)) {
    if (!repos.has(repo)) continue;
    const id = `${cfg.owner}/${cfg.number}`;
    if (!cache.has(id)) cache.set(id, api.projectItems(cfg.owner, cfg.number));
    try {
      const items = await cache.get(id)!;
      const ranked = items.filter((i) => eligible.has(i.url)).sort((a, b) => a.index - b.index);
      views.set(repo, {
        label: `${cfg.owner}/projects/${cfg.number}`,
        cfg,
        byUrl: new Map(items.map((i) => [i.url, i])),
        rank: new Map(ranked.map((i, r) => [i.url, r])),
      });
    } catch (err) {
      errors[repo] = (err as Error).message;
    }
  }
  return { views, errors };
}

function fieldValue(item: GitHubProjectItem, field: string): string | number | undefined {
  const want = field.toLowerCase();
  const key = Object.keys(item.fields).find((k) => k.toLowerCase() === want);
  return key === undefined ? undefined : item.fields[key];
}

function mapOption(map: Record<string, number> | undefined, value: string): number | undefined {
  if (!map) return undefined;
  if (value in map) return map[value];
  const key = Object.keys(map).find((k) => k.toLowerCase() === value.toLowerCase());
  return key === undefined ? undefined : map[key];
}

const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

function fromProject(issue: GitHubIssue, view: ProjectView): Priority | { projectItem: string } {
  const item = view.byUrl.get(issue.url);
  if (!item) return { projectItem: 'none' };
  if (view.cfg.mode === 'rank') {
    const r = view.rank.get(issue.url);
    if (r === undefined) return { projectItem: view.label };
    return { priority: Math.max(0, 100 - r), reason: `project:rank=${r + 1}`, projectItem: `${view.label} · rank ${r + 1}` };
  }
  const field = view.cfg.field!;
  const value = fieldValue(item, field);
  if (value === undefined) return { projectItem: view.label };
  const projectItem = `${view.label} · ${field}=${value}`;
  const n = typeof value === 'number' ? clamp(value) : mapOption(view.cfg.map, value);
  if (n === undefined) return { projectItem };
  return { priority: n, reason: `project:${field}=${value}`, projectItem };
}

export function priorityOf(issue: GitHubIssue, config: GitHubSourceConfig, view: ProjectView | undefined): Priority {
  let projectItem = 'none';
  if (view) {
    const p = fromProject(issue, view);
    if ('priority' in p) return p;
    projectItem = p.projectItem;
  }
  let best: { label: string; value: number } | undefined;
  for (const label of issue.labels) {
    const value = config.priorityLabels[label];
    if (value !== undefined && (!best || value > best.value)) best = { label, value };
  }
  if (best) return { priority: best.value, reason: `label:${best.label}`, projectItem };
  return { priority: config.defaultPriority, reason: 'default', projectItem };
}
