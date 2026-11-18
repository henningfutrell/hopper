// A fake Claude Enterprise Analytics API on loopback (issue #2966): `/v1/organizations/analytics/users`, `/cost` and
// `/usage`, in the shapes the API reference gives (https://platform.claude.com/docs/en/api/beta/organization/analytics),
// paged by `page`. It takes one key, answers a day after its newest with the 400 that names the newest, and records
// every request. Never a real URL: the tests' network guard refuses anything off loopback.
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUser {
  id: string; email: string | null; name?: string;
  sessions: number; commits: number; pullRequests: number; added: number; removed: number;
  edit: [accepted: number, rejected: number]; write: [accepted: number, rejected: number];
  /** Claude Code cost on the day, decimal cents, and tokens. */
  cents: string; input: number; output: number; cacheRead: number; cache5m: number; cache1h: number;
}

export interface Seen { path: string; query: URLSearchParams; headers: IncomingHttpHeaders }

export interface FakeAnalytics {
  url: string;
  seen: Seen[];
  /** The organization's users, as the API lists them. */
  users: FakeUser[];
  /** The key the fake takes. */
  key: string;
  /** The newest day it has: a later `date` is a 400 that names it. */
  newestDay: string;
  /** Users per page of `/analytics/users`. */
  pageSize: number;
  /** A status and body to answer every request with, in place of the data. */
  fail?: { status: number; body: unknown };
  close(): Promise<void>;
}

export function fakeUser(id: string, email: string | null, over: Partial<FakeUser> = {}): FakeUser {
  return {
    id, email, name: `Name of ${id}`, sessions: 5, commits: 12, pullRequests: 2, added: 1543, removed: 892, edit: [45, 5], write: [8, 1],
    cents: '113.500000', input: 100000, output: 35000, cacheRead: 10000, cache5m: 4000, cache1h: 1000, ...over,
  };
}

export async function startFakeAnalytics(): Promise<FakeAnalytics> {
  const fake: Omit<FakeAnalytics, 'url' | 'close'> = { seen: [], users: [], key: 'analytics-key-for-tests', newestDay: '2026-10-02', pageSize: 1000 };
  const server: Server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://fake');
    fake.seen.push({ path: u.pathname, query: u.searchParams, headers: req.headers });
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers['x-api-key'] !== fake.key) return send(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    if (fake.fail) return send(fake.fail.status, fake.fail.body);
    const q = u.searchParams;
    if (u.pathname === '/v1/organizations/analytics/users') {
      const date = q.get('date') ?? '';
      if (date > fake.newestDay) return send(400, { type: 'error', error: { type: 'invalid_request_error', message: `date ${date} is not available yet; the most recent available day is ${fake.newestDay}` } });
      const from = Number(q.get('page') ?? '0');
      const slice = fake.users.slice(from, from + fake.pageSize);
      return send(200, {
        data: slice.map((x) => ({
          user: { type: 'user', id: x.id, email_address: x.email }, name: x.name, last_activity_date: date,
          chat_metrics: { message_count: 3 }, web_search_count: 1,
          claude_code_metrics: {
            core_metrics: { artifacts_created_count: 0, commit_count: x.commits, distinct_session_count: x.sessions, pull_request_count: x.pullRequests, lines_of_code: { added_count: x.added, removed_count: x.removed } },
            tool_actions: { edit_tool: { accepted_count: x.edit[0], rejected_count: x.edit[1] }, multi_edit_tool: null, notebook_edit_tool: { accepted_count: 0, rejected_count: 0 }, write_tool: { accepted_count: x.write[0], rejected_count: x.write[1] } },
          },
        })),
        next_page: from + fake.pageSize < fake.users.length ? String(from + fake.pageSize) : null,
      });
    }
    if (u.pathname === '/v1/organizations/analytics/cost' || u.pathname === '/v1/organizations/analytics/usage') {
      if (req.headers['anthropic-beta'] !== 'analytics-usage-cost-2026-08-24') return send(400, { type: 'error', error: { message: 'the anthropic-beta header is required' } });
      const ids = q.getAll('actor_ids[]');
      const of = fake.users.filter((x) => ids.length === 0 || ids.includes(x.id));
      const bucket = { starting_at: q.get('starting_at'), ending_at: q.get('ending_at') };
      const group = (x: FakeUser) => ({ product: null, model: null, actor: { type: 'user_actor', user_id: x.id, deleted: false } });
      // Two rows per user (one per model, as a grouping by actor and model would give), so the source sums them.
      const data = u.pathname.endsWith('/cost')
        ? of.flatMap((x) => [{ ...bucket, group: group(x), cost: { currency: 'USD', amount: x.cents, list_amount: x.cents, requests: 3 } }, { ...bucket, group: group(x), cost: { currency: 'USD', amount: '0.250000', list_amount: '0.250000', requests: 1 } }])
        : of.flatMap((x) => [{ ...bucket, group: group(x), usage: { uncached_input_tokens: x.input, output_tokens: x.output, cache_read_input_tokens: x.cacheRead, cache_creation: { ephemeral_1h_input_tokens: x.cache1h, ephemeral_5m_input_tokens: x.cache5m }, total_tokens: 1, requests: 3 } }]);
      // Unattributed use: no actor.
      data.push({ ...bucket, group: { product: null, model: null, actor: null }, ...(u.pathname.endsWith('/cost') ? { cost: { currency: 'USD', amount: '999.000000', list_amount: '999.000000', requests: 1 } } : { usage: { uncached_input_tokens: 9, output_tokens: 9, cache_read_input_tokens: 9, cache_creation: null, total_tokens: 27, requests: 1 } }) } as never);
      return send(200, { data, has_more: false, next_page: null, data_refreshed_at: '2026-10-03T08:00:00Z' });
    }
    send(404, { type: 'error', error: { message: 'not found' } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fake, {
    url,
    async close() { server.closeAllConnections(); await new Promise((r) => server.close(r)); },
  });
}
