// The issue graph (issue #437, tenant migration 42): its nodes, one row each, what the reads said of it merged as JSON;
// and its edges, kept per read issue (`read_of`), so a new read of an issue replaces only the edges its read before gave.
// `read_at` is set on the node of an issue that was read itself.
import type { GraphEdge, GraphEdgeKind, GraphNode, GraphNodeKind, IssueGraphRepository } from '../domain/issue-graph.ts';
import { parse, type StoreContext } from './context.ts';

export const ISSUE_GRAPH_TABLES = `
  CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, attrs TEXT NOT NULL, read_at TEXT);
  CREATE TABLE graph_edges (
    read_of TEXT NOT NULL,
    from_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    to_id TEXT NOT NULL,
    PRIMARY KEY (read_of, from_id, kind, to_id)
  );
  CREATE INDEX graph_edges_from ON graph_edges (from_id);
  CREATE INDEX graph_edges_to ON graph_edges (to_id)`;

const nodeOf = (r: Record<string, unknown>): GraphNode => ({ id: String(r.id), kind: String(r.kind) as GraphNodeKind, attrs: parse<GraphNode['attrs']>(r.attrs) });

export function createIssueGraphRepository(c: StoreContext): IssueGraphRepository {
  return {
    record(issue, graph, readAt) {
      c.tx(() => {
        for (const n of graph.nodes) {
          c.db.run(`INSERT INTO graph_nodes (id, kind, attrs) VALUES (?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, attrs = (graph_nodes.attrs::jsonb || EXCLUDED.attrs::jsonb)::text`,
          n.id, n.kind, JSON.stringify(n.attrs));
        }
        c.db.run('UPDATE graph_nodes SET read_at = ? WHERE id = ?', readAt, issue);
        c.db.run('DELETE FROM graph_edges WHERE read_of = ?', issue);
        for (const e of graph.edges) {
          c.db.run('INSERT INTO graph_edges (read_of, from_id, kind, to_id) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', issue, e.from, e.kind, e.to);
        }
      });
    },
    lastRead(issue) {
      const r = c.db.get('SELECT read_at, attrs::jsonb->>\'updatedAt\' AS updated_at FROM graph_nodes WHERE id = ? AND read_at IS NOT NULL', issue);
      return r ? { readAt: String(r.read_at), ...(r.updated_at != null ? { updatedAt: String(r.updated_at) } : {}) } : undefined;
    },
    node(id) {
      const r = c.db.get('SELECT id, kind, attrs FROM graph_nodes WHERE id = ?', id);
      return r ? nodeOf(r) : undefined;
    },
    nodes(kind) {
      const rows = kind ? c.db.all('SELECT id, kind, attrs FROM graph_nodes WHERE kind = ? ORDER BY id', kind) : c.db.all('SELECT id, kind, attrs FROM graph_nodes ORDER BY id');
      return rows.map(nodeOf);
    },
    edges() {
      return c.db.all('SELECT DISTINCT from_id, kind, to_id FROM graph_edges ORDER BY from_id, kind, to_id')
        .map((r): GraphEdge => ({ from: String(r.from_id), kind: String(r.kind) as GraphEdgeKind, to: String(r.to_id) }));
    },
  };
}
