// The telemetry summary (issue #1486, design.md "Telemetry summary"): the hopper keeps the slowest actions, each job span's
// duration and its GitHub calls in its own process, telemetry on or off, for the Resources page. Behaviour only: the
// times are given, never measured, and no id, query, token or text is kept.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { TELEMETRY_SUMMARY_SAMPLES, TELEMETRY_SUMMARY_TOP } from '../../src/domain/types.ts';
import { createGitHubLimiter } from '../../src/github-limiter/limiter.ts';
import { makeRequest } from '../../src/sources/github/http/http.ts';
import { instrumentHttp } from '../../src/telemetry/http.ts';
import { traceJobs } from '../../src/telemetry/jobs.ts';
import { createTelemetrySummary, telemetrySummary } from '../../src/telemetry/summary.ts';

const START = new Date('2026-10-16T10:00:00Z');

describe('createTelemetrySummary', () => {
  it('starts empty, from the process\'s start, and says whether telemetry is exported', () => {
    const s = createTelemetrySummary(() => START);
    expect(s.read()).toEqual({ since: START.toISOString(), exporting: false, actions: [], jobSpans: [], github: [], githubCalls: 0, githubCacheHits: 0 });
    s.exporting(true);
    expect(s.read().exporting).toBe(true);
  });

  it('keeps the slowest actions first, by p95, at most the top ones; a read is no action', () => {
    const s = createTelemetrySummary(() => START);
    s.action('POST', '/ui/api/jobs/:id/approve', 0.2);
    s.action('POST', '/ui/api/jobs/:id/approve', 0.4);
    s.action('POST', '/ui/api/jobs/:id/discard', 1.5);
    s.action('GET', '/api/jobs', 9);
    s.action('HEAD', '/api/jobs', 9);
    const { actions } = s.read();
    expect(actions.map((a) => a.name)).toEqual(['POST /ui/api/jobs/:id/discard', 'POST /ui/api/jobs/:id/approve']);
    expect(actions[1]).toEqual({ name: 'POST /ui/api/jobs/:id/approve', count: 2, meanMs: 300, p95Ms: 400, maxMs: 400 });
    for (let i = 0; i < TELEMETRY_SUMMARY_TOP + 5; i++) s.action('POST', `/ui/api/r${i}`, i);
    expect(s.read().actions).toHaveLength(TELEMETRY_SUMMARY_TOP);
    expect(s.read().actions[0]?.name).toBe(`POST /ui/api/r${TELEMETRY_SUMMARY_TOP + 4}`);
  });

  it('counts every sample, and times over the last ones kept', () => {
    const s = createTelemetrySummary(() => START);
    s.jobSpan('run', 1000);
    for (let i = 0; i < TELEMETRY_SUMMARY_SAMPLES; i++) s.jobSpan('run', 10);
    expect(s.read().jobSpans).toEqual([{ name: 'run', count: TELEMETRY_SUMMARY_SAMPLES + 1, meanMs: 10, p95Ms: 10, maxMs: 10 }]);
  });

  it('counts GitHub calls by route, most called first, with cache hits and errors', () => {
    const s = createTelemetrySummary(() => START);
    s.githubCall('GET', '/repos/{owner}/{repo}/pulls', 200, 'miss', 0.1);
    s.githubCall('GET', '/repos/{owner}/{repo}/pulls', 304, 'hit', 0.05);
    s.githubCall('GET', '/repos/{owner}/{repo}/pulls', undefined, 'miss', 0.3);
    s.githubCall('POST', '/repos/{owner}/{repo}/issues', 422, 'none', 0.2);
    const r = s.read();
    expect(r.githubCalls).toBe(4);
    expect(r.githubCacheHits).toBe(1);
    expect(r.github.map((g) => [g.name, g.count, g.cacheHits, g.errors])).toEqual([
      ['GET /repos/{owner}/{repo}/pulls', 3, 1, 1],
      ['POST /repos/{owner}/{repo}/issues', 1, 0, 1],
    ]);
  });
});

describe('the summary is fed with telemetry off (issue #1486)', () => {
  beforeEach(() => { telemetrySummary.reset(); });
  afterEach(() => { telemetrySummary.reset(); });

  it('an action\'s route template, not its URL', async () => {
    const app = Fastify();
    instrumentHttp(app);
    app.post('/ui/api/jobs/:id/approve', async () => ({ ok: true }));
    app.get('/api/jobs', async () => []);
    await app.ready();
    await app.inject({ method: 'POST', url: '/ui/api/jobs/JOB-ID-IN-URL/approve?token=SECRET-QUERY', payload: {} });
    await app.inject({ method: 'GET', url: '/api/jobs' });
    await app.close();
    const { actions } = telemetrySummary.read();
    expect(actions.map((a) => [a.name, a.count])).toEqual([['POST /ui/api/jobs/:id/approve', 1]]);
    expect(JSON.stringify(telemetrySummary.read())).not.toMatch(/JOB-ID-IN-URL|SECRET-QUERY/);
  });

  it('each job span that ends, timed by its events', () => {
    const listeners = new Set<(e: DomainEvent) => void>();
    let seq = 0;
    const emit = (type: EventType, at: string) => {
      const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at, jobId: 'j1', data: {} };
      for (const l of listeners) l(e);
    };
    const job = { id: 'j1', spec: { executor: 'herdr-claude', payload: {} }, priority: 50, status: 'queued', approved: false, createdAt: '', updatedAt: '', attempts: 0 } as unknown as Job;
    const stop = traceJobs({ subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; }, job: () => job });
    emit('job.queued', '2026-10-16T10:00:00.000Z');
    emit('job.started', '2026-10-16T10:00:02.000Z');
    emit('job.finished', '2026-10-16T10:00:05.000Z');
    stop();
    expect(telemetrySummary.read().jobSpans).toEqual([
      { name: 'run', count: 1, meanMs: 3000, p95Ms: 3000, maxMs: 3000 },
      { name: 'queue', count: 1, meanMs: 2000, p95Ms: 2000, maxMs: 2000 },
    ]);
  });

  describe('GitHub calls', () => {
    let gh: Server | undefined;
    afterEach(async () => { if (gh) await new Promise((r) => gh!.close(r)); gh = undefined; });

    it('by route, a conditional hit as a cache hit', async () => {
      gh = createServer((req: IncomingMessage, res: ServerResponse) => {
        if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"' }); return res.end(); }
        res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"' });
        res.end('{"number":1}');
      });
      await new Promise<void>((r) => gh!.listen(0, '127.0.0.1', r));
      const { port } = gh.address() as AddressInfo;
      const req = makeRequest(`http://127.0.0.1:${port}`, createGitHubLimiter({}));
      const get = () => req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n: 1, headers: { authorization: 'token SECRET-GH-TOKEN' } });
      await get();
      await get();
      const r = telemetrySummary.read();
      expect(r.githubCalls).toBe(2);
      expect(r.githubCacheHits).toBe(1);
      expect(r.github.map((g) => [g.name, g.count, g.cacheHits, g.errors])).toEqual([['GET /repos/{owner}/{repo}/issues/{n}', 2, 1, 0]]);
      expect(JSON.stringify(r)).not.toContain('SECRET-GH-TOKEN');
    });
  });
});
