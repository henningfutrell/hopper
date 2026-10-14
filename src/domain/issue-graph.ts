// The issue graph (issue #437, design.md "The issue graph"): every issue a GitHub source sees, kept with its repository,
// that repository's owner, the Projects it is in and the issues and pull requests linked to it, as nodes and edges in the
// user's store. Read by the job graph and by search (issue #945). Pure: what one read of an issue says becomes nodes and edges here.

/** An owner (a GitHub organization or user), a repository, an issue, a pull request, or a Project (v2). */
export type GraphNodeKind = 'owner' | 'repo' | 'issue' | 'pull_request' | 'project';

/**
 * `owned_by`: a repository or a Project to its owner. `in_repo`: an issue or a pull request to its repository.
 * `in_project`: an issue to a Project it is an item of. `closes`: a pull request to the issue its merge closes.
 * `references`: an issue or pull request to an issue it mentions. `sub_issue_of`: a sub-issue to its parent.
 * `blocked_by`: an issue to an issue that blocks it (GitHub's issue dependencies, issue #900).
 */
export type GraphEdgeKind = 'owned_by' | 'in_repo' | 'in_project' | 'closes' | 'references' | 'sub_issue_of' | 'blocked_by';

export interface GraphNode {
  /** `owner:<login>`, `repo:<owner/name>` (lowercase: GitHub ignores case there), else the item's URL. */
  id: string;
  kind: GraphNodeKind;
  /** What the newest read said of it: a name, a title, a state. A read that does not know a value leaves it. */
  attrs: Record<string, string | number>;
}

export interface GraphEdge { from: string; kind: GraphEdgeKind; to: string }

export interface IssueGraph { nodes: GraphNode[]; edges: GraphEdge[] }

/** An issue or a pull request another item names. `stateReason`: why a closed issue closed (`completed`, `not_planned`, `duplicate`, issue #1036). */
export interface ItemRef { kind: 'issue' | 'pull_request'; repo: string; number: number; url: string; state?: string; stateReason?: string }

/** What one read of an issue on GitHub says of its place. */
export interface IssuePlace {
  /** `stateReason`: why it closed, when it is closed (issue #1036). */
  issue: { repo: string; number: number; url: string; title: string; state: string; stateReason?: string; updatedAt: string };
  /** The owner of the issue's repository: an organization or a user (absent: GitHub did not say which). */
  owner: { login: string; type?: 'Organization' | 'User' };
  projects: { owner: string; number: number; url: string; title?: string }[];
  /** The pull requests whose merge closes the issue, any state. */
  closedBy: ItemRef[];
  /** The issues and pull requests that mention the issue (its timeline's cross-references). */
  references: ItemRef[];
  parent?: ItemRef;
  subIssues: ItemRef[];
  /** The issues that block it (issue #900); absent: the GitHub asked has no issue dependencies. */
  blockedBy?: ItemRef[];
}

/** When an issue was read for the graph last, and the `updatedAt` it had then. */
export interface GraphRead { readAt: string; updatedAt?: string }

/** The issue graph's store (tenant migration 42): the nodes and, per read issue, the edges its newest read gave. */
export interface IssueGraphRepository {
  /** Keep a read of `issue`: every node is added or updated, and the edges it gives replace those its read before gave. */
  record(issue: string, graph: IssueGraph, readAt: string): void;
  lastRead(issue: string): GraphRead | undefined;
  node(id: string): GraphNode | undefined;
  nodes(kind?: GraphNodeKind): GraphNode[];
  /** Every edge some read gives now, once each. */
  edges(): GraphEdge[];
  /** The edges from or to one node, once each (search, issue #945). */
  edgesOf(id: string): GraphEdge[];
}

export const ownerId = (login: string): string => `owner:${login.toLowerCase()}`;
export const repoId = (repo: string): string => `repo:${repo.toLowerCase()}`;
const ownerOf = (repo: string): string => repo.slice(0, repo.indexOf('/'));

/** The nodes and edges one read of an issue gives, each once. */
export function placeGraph(place: IssuePlace): IssueGraph {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const node = (id: string, kind: GraphNodeKind, attrs: GraphNode['attrs']) => {
    const before = nodes.get(id);
    nodes.set(id, { id, kind, attrs: { ...before?.attrs, ...attrs } });
    return id;
  };
  const edge = (from: string, kind: GraphEdgeKind, to: string) => { edges.set(`${from} ${kind} ${to}`, { from, kind, to }); };
  const repo = (name: string) => {
    const id = node(repoId(name), 'repo', { name });
    edge(id, 'owned_by', node(ownerId(ownerOf(name)), 'owner', { login: ownerOf(name) }));
    return id;
  };
  const item = (r: ItemRef) => {
    const id = node(r.url, r.kind, { repo: r.repo, number: r.number, ...(r.state ? { state: r.state } : {}), ...(r.stateReason ? { stateReason: r.stateReason } : {}) });
    edge(id, 'in_repo', repo(r.repo));
    return id;
  };
  const { issue, owner } = place;
  const own = node(ownerId(owner.login), 'owner', { login: owner.login, ...(owner.type ? { type: owner.type } : {}) });
  const at = node(issue.url, 'issue', { repo: issue.repo, number: issue.number, title: issue.title, state: issue.state, ...(issue.stateReason ? { stateReason: issue.stateReason } : {}), updatedAt: issue.updatedAt });
  edge(at, 'in_repo', repo(issue.repo));
  edge(repoId(issue.repo), 'owned_by', own);
  for (const p of place.projects) {
    const id = node(p.url, 'project', { owner: p.owner, number: p.number, ...(p.title ? { title: p.title } : {}) });
    edge(id, 'owned_by', node(ownerId(p.owner), 'owner', { login: p.owner }));
    edge(at, 'in_project', id);
  }
  for (const pr of place.closedBy) edge(item(pr), 'closes', at);
  for (const r of place.references) edge(item(r), 'references', at);
  if (place.parent) edge(at, 'sub_issue_of', item(place.parent));
  for (const s of place.subIssues) edge(item(s), 'sub_issue_of', at);
  for (const b of place.blockedBy ?? []) edge(at, 'blocked_by', item(b));
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}
