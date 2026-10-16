// OpenTelemetry (issue #1486, design.md "Telemetry"): off unless the launch's OTEL_* variables name an exporter; on, a
// job is one trace with a span for each job span, every request is a span with its route's latency recorded, GitHub calls
// and store calls are counted, and every log line goes out as a log record with the trace it was written in. Behaviour
// only: in-memory exporters, no timing asserted, and no secret in anything exported.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Writable } from 'node:stream';
import { trace } from '@opentelemetry/api';
import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { MetricReader, type ResourceMetrics } from '@opentelemetry/sdk-metrics';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DomainEvent, EventType, Job } from '../../src/domain/types.ts';
import { createGitHubLimiter } from '../../src/github-limiter/limiter.ts';
import { makeRequest } from '../../src/sources/github/http/http.ts';
import { instrumentHttp } from '../../src/telemetry/http.ts';
import { traceJobs } from '../../src/telemetry/jobs.ts';
import { bridgeLogStream } from '../../src/telemetry/logs.ts';
import { observeProcess } from '../../src/telemetry/process.ts';
import { countBy, observeQueue } from '../../src/telemetry/queue.ts';
import { startTelemetry, telemetryWanted, type Telemetry } from '../../src/telemetry/sdk.ts';

class TestReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

// Fresh each test: a shutdown stops its exporters.
let spans: InMemorySpanExporter;
let logs: InMemoryLogRecordExporter;
let reader: TestReader;
let telemetry: Telemetry;

beforeEach(() => {
  spans = new InMemorySpanExporter();
  logs = new InMemoryLogRecordExporter();
  reader = new TestReader();
  telemetry = startTelemetry({
    env: {}, version: '0.0.0-test',
    spanProcessors: [new SimpleSpanProcessor(spans)], metricReaders: [reader], logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logs })],
  });
});
afterEach(async () => { await telemetry.shutdown(); });

async function metricsNow(): Promise<ResourceMetrics> {
  return (await reader.collect()).resourceMetrics;
}
function metric(rm: ResourceMetrics, name: string) {
  return rm.scopeMetrics.flatMap((s) => s.metrics).find((m) => m.descriptor.name === name);
}
const byName = (name: string): ReadableSpan[] => spans.getFinishedSpans().filter((s) => s.name === name);
const parentOf = (s: ReadableSpan): string | undefined => s.parentSpanContext?.spanId;

describe('telemetryWanted (issue #1486)', () => {
  it('is off when the launch names no exporter: nothing outside the stack is needed', () => {
    expect(telemetryWanted({})).toBe(false);
    expect(telemetryWanted({ OTEL_SERVICE_NAME: 'hopper' })).toBe(false);
  });
  it('is on when an OTLP endpoint or an exporter is named', () => {
    expect(telemetryWanted({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318' })).toBe(true);
    expect(telemetryWanted({ OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://collector:4318/v1/traces' })).toBe(true);
    expect(telemetryWanted({ OTEL_TRACES_EXPORTER: 'console' })).toBe(true);
  });
  it('is off when the SDK is disabled, or every exporter is none', () => {
    expect(telemetryWanted({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318', OTEL_SDK_DISABLED: 'true' })).toBe(false);
    expect(telemetryWanted({ OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' })).toBe(false);
  });
  it('off, startTelemetry starts nothing', async () => {
    const off = startTelemetry({ env: {}, version: '0.0.0-test' });
    expect(off.enabled).toBe(false);
    await off.shutdown();
  });
});

describe('a job is one trace (issue #1486)', () => {
  function bus() {
    const listeners = new Set<(e: DomainEvent) => void>();
    let seq = 0;
    let t = Date.parse('2026-10-16T10:00:00Z');
    return {
      subscribe: (l: (e: DomainEvent) => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
      emit(type: EventType, more: Partial<DomainEvent> = {}, data: Record<string, unknown> = {}) {
        t += 1000;
        const e: DomainEvent = { schemaVersion: 1, seq: ++seq, id: `e${seq}`, type, at: new Date(t).toISOString(), jobId: 'j1', data, ...more };
        for (const l of listeners) l(e);
      },
    };
  }
  const job = (o: Partial<Job> = {}): Job => ({
    id: 'j1', spec: { executor: 'herdr-claude', payload: { prompt: 'SECRET-PROMPT-TEXT' } }, priority: 50, status: 'queued', approved: false,
    createdAt: '2026-10-16T10:00:00Z', updatedAt: '2026-10-16T10:00:00Z', attempts: 0,
    source: { source: 'github', kind: 'github', key: 'https://github.com/o/r/issues/7', repo: 'o/r', number: 7, title: 'SECRET-TITLE' }, ...o,
  });

  it('has a root span and a child span for each job span, each parented on the root, with the job\'s attributes', async () => {
    const b = bus();
    let current = job();
    const stop = traceJobs({ subscribe: b.subscribe, job: () => current });
    b.emit('job.queued');
    current = job({ status: 'claimed', laneId: 'desk/lane-1' });
    b.emit('job.claimed', { laneId: 'desk/lane-1' });
    b.emit('job.started', { laneId: 'desk/lane-1', machineId: 'desk' });
    b.emit('question.asked', { questionId: 'q1' }, { text: 'SECRET-QUESTION' });
    b.emit('question.escalated', { questionId: 'q1' }, { questionId: 'q1', target: 'human', text: 'SECRET-QUESTION' });
    b.emit('question.answered', { questionId: 'q1' }, { answer: 'SECRET-ANSWER' });
    b.emit('job.started', { laneId: 'desk/lane-1', machineId: 'desk' });
    current = job({ status: 'finished', laneId: 'desk/lane-1' });
    b.emit('job.finished', { laneId: 'desk/lane-1' });
    expect(byName('hopper.job')).toHaveLength(1); // the job's end ends its root
    // Its pull request is followed after it ended: a job span of the same trace.
    b.emit('job.pull_request_followed', {}, { pullRequest: 'https://github.com/o/r/pull/12' });
    b.emit('job.pull_request_merged', {}, { pullRequest: 'https://github.com/o/r/pull/12' });
    stop();

    const [root] = byName('hopper.job');
    expect(root).toBeDefined();
    expect(parentOf(root!)).toBeUndefined();
    expect(root!.attributes).toMatchObject({
      'hopper.job.id': 'j1', 'hopper.job.executor': 'herdr-claude', 'hopper.repo': 'o/r', 'hopper.issue.number': 7,
      'hopper.lane.id': 'desk/lane-1', 'hopper.machine.id': 'desk', 'hopper.job.outcome': 'finished',
    });
    expect(byName('hopper.job.pull_request')[0]?.attributes['hopper.pull_request.number']).toBe(12);
    const jobSpans = spans.getFinishedSpans().filter((s) => s !== root);
    expect(jobSpans.map((s) => s.name).sort()).toEqual(['hopper.job.pull_request', 'hopper.job.question', 'hopper.job.queue', 'hopper.job.run', 'hopper.job.run'].sort());
    for (const s of jobSpans) {
      expect(s.spanContext().traceId).toBe(root!.spanContext().traceId);
      expect(parentOf(s)).toBe(root!.spanContext().spanId);
    }
    const [question] = byName('hopper.job.question');
    expect(question!.events.map((e) => e.name)).toContain('question.escalated');
    expect(question!.events.find((e) => e.name === 'question.escalated')!.attributes).toEqual({ 'hopper.question.target': 'human' });
    // The job span's time is the events': the queue lasted from queued to claimed.
    const [queue] = byName('hopper.job.queue');
    expect(queue!.duration).toEqual([1, 0]);

    const rm = await metricsNow();
    const kinds = metric(rm, 'hopper.job.span.duration');
    expect(kinds?.dataPoints.map((p) => p.attributes['hopper.job.span']).sort()).toEqual(['pull_request', 'question', 'queue', 'run']);
    const ended = metric(rm, 'hopper.job.ended');
    expect(ended?.dataPoints).toEqual([expect.objectContaining({ attributes: { 'hopper.job.outcome': 'finished', 'hopper.job.executor': 'herdr-claude' }, value: 1 })]);

    const exported = JSON.stringify([spans.getFinishedSpans().map((s) => ({ a: s.attributes, e: s.events })), rm]);
    for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-TITLE', 'SECRET-QUESTION', 'SECRET-ANSWER']) expect(exported).not.toContain(secret);
  });

  it('a job that fails with no pull request ends its trace at once, its open job span with it', () => {
    const b = bus();
    let current = job();
    const stop = traceJobs({ subscribe: b.subscribe, job: () => current });
    b.emit('job.started');
    current = job({ status: 'failed' });
    b.emit('job.failed', {}, { error: 'SECRET-ERROR' });
    stop();
    expect(byName('hopper.job')[0]?.attributes['hopper.job.outcome']).toBe('failed');
    expect(byName('hopper.job.run')).toHaveLength(1);
    expect(JSON.stringify(spans.getFinishedSpans().map((s) => s.attributes))).not.toContain('SECRET-ERROR');
  });

  it('keeps at most `max` jobs open: the oldest is ended, marked evicted', () => {
    const b = bus();
    const stop = traceJobs({ subscribe: b.subscribe, job: (id) => job({ id }), max: 2 });
    for (const id of ['a', 'b', 'c']) b.emit('job.queued', { jobId: id });
    stop();
    const evicted = byName('hopper.job').filter((s) => s.attributes['hopper.trace.evicted'] === true);
    expect(evicted.map((s) => s.attributes['hopper.job.id'])).toEqual(['a']);
  });
});

describe('a request is a span, with its latency (issue #1486)', () => {
  it('names its route, parents the handler\'s spans and log lines, records the latency, and carries no secret', async () => {
    const app = Fastify();
    instrumentHttp(app);
    const lines: string[] = [];
    const out = new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } });
    bridgeLogStream(out, 'info');
    app.post('/ui/api/jobs/:id/approve', async () => {
      await new Promise((r) => setTimeout(r, 1));
      trace.getTracer('test').startSpan('inner').end();
      out.write('hopper: approved\n');
      return { ok: true };
    });
    await app.ready();
    const r = await app.inject({
      method: 'POST', url: '/ui/api/jobs/JOB-ID-IN-URL/approve?token=SECRET-QUERY',
      headers: { 'x-hopper-session': 'SECRET-SESSION', authorization: 'Bearer SECRET-BEARER' }, payload: { note: 'SECRET-BODY' },
    });
    expect(r.statusCode).toBe(200);
    await app.close();

    const [server] = byName('POST /ui/api/jobs/:id/approve');
    expect(server?.attributes).toMatchObject({ 'http.request.method': 'POST', 'http.route': '/ui/api/jobs/:id/approve', 'http.response.status_code': 200 });
    const [inner] = byName('inner');
    expect(parentOf(inner!)).toBe(server!.spanContext().spanId);
    const records = logs.getFinishedLogRecords();
    const line = records.find((l) => l.body === 'hopper: approved');
    expect(line?.spanContext?.traceId).toBe(server!.spanContext().traceId);
    expect(lines).toEqual(['hopper: approved\n']); // the stream still gets its line

    const rm = await metricsNow();
    const latency = metric(rm, 'http.server.request.duration');
    expect(latency?.dataPoints[0]?.attributes).toEqual({ 'http.request.method': 'POST', 'http.route': '/ui/api/jobs/:id/approve', 'http.response.status_code': 200 });

    const exported = JSON.stringify([spans.getFinishedSpans().map((s) => ({ n: s.name, a: s.attributes, e: s.events })), records.map((l) => ({ b: l.body, a: l.attributes })), rm]);
    for (const secret of ['SECRET-QUERY', 'SECRET-SESSION', 'SECRET-BEARER', 'SECRET-BODY', 'JOB-ID-IN-URL']) expect(exported).not.toContain(secret);
  });

  it('a route with no match is named by none, and a 404 is recorded', async () => {
    const app = Fastify();
    instrumentHttp(app);
    await app.ready();
    await app.inject({ method: 'GET', url: '/no/such/SECRET-PATH' });
    await app.close();
    const [s] = spans.getFinishedSpans();
    expect(s?.name).toBe('GET');
    expect(s?.attributes['http.response.status_code']).toBe(404);
    expect(JSON.stringify(s?.attributes)).not.toContain('SECRET-PATH');
  });
});

describe('GitHub calls are counted (issue #1486)', () => {
  let gh: Server | undefined;
  afterEach(async () => { if (gh) await new Promise((r) => gh!.close(r)); gh = undefined; });

  it('each call by its route and status, a conditional hit as a hit, and the calls left', async () => {
    gh = createServer((req: IncomingMessage, res: ServerResponse) => {
      const rate = { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': '9999999999', 'x-ratelimit-resource': 'core' };
      if (req.headers['if-none-match'] === '"v1"') { res.writeHead(304, { etag: '"v1"', ...rate }); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', etag: '"v1"', ...rate });
      res.end('{"number":1}');
    });
    await new Promise<void>((r) => gh!.listen(0, '127.0.0.1', r));
    const { port } = gh.address() as AddressInfo;
    const req = makeRequest(`http://127.0.0.1:${port}`, createGitHubLimiter({}));
    const get = () => req('GET /repos/{owner}/{repo}/issues/{n}', { owner: 'o', repo: 'r', n: 1, headers: { authorization: 'token SECRET-GH-TOKEN' } });
    await get();
    await get();

    const rm = await metricsNow();
    const calls = metric(rm, 'hopper.github.calls');
    const points = (calls?.dataPoints ?? []).map((p) => ({ ...p.attributes, value: p.value }));
    expect(points).toEqual(expect.arrayContaining([
      { 'http.request.method': 'GET', 'http.route': '/repos/{owner}/{repo}/issues/{n}', 'http.response.status_code': 200, 'hopper.github.cache': 'miss', value: 1 },
      { 'http.request.method': 'GET', 'http.route': '/repos/{owner}/{repo}/issues/{n}', 'http.response.status_code': 304, 'hopper.github.cache': 'hit', value: 1 },
    ]));
    const left = metric(rm, 'hopper.github.rate_limit.remaining');
    expect(left?.dataPoints.map((p) => ({ ...p.attributes, value: p.value }))).toEqual([{ 'hopper.github.resource': 'core', value: 4321 }]);
    const [span] = byName('GitHub GET /repos/{owner}/{repo}/issues/{n}');
    expect(span).toBeDefined();
    expect(JSON.stringify([rm, spans.getFinishedSpans().map((s) => s.attributes)])).not.toContain('SECRET-GH-TOKEN');
  });
});

describe('the process (issue #1486)', () => {
  it('reports its memory, CPU time and event loop delay', async () => {
    const stop = observeProcess();
    const rm = await metricsNow();
    stop();
    for (const name of ['process.memory.usage', 'process.cpu.time', 'nodejs.eventloop.delay.max']) expect(metric(rm, name), name).toBeDefined();
  });
});

describe('the queue (issue #1486)', () => {
  it('reports the live jobs by status and the lanes by state', async () => {
    const stop = observeQueue(() => ({ jobs: countBy(['queued', 'running', 'queued'], (s) => s), lanes: { busy: 1, idle: 2 } }));
    const rm = await metricsNow();
    stop();
    expect(metric(rm, 'hopper.jobs')?.dataPoints.map((p) => [p.attributes['hopper.job.status'], p.value])).toEqual([['queued', 2], ['running', 1]]);
    expect(metric(rm, 'hopper.lanes')?.dataPoints.map((p) => [p.attributes['hopper.lane.state'], p.value])).toEqual([['busy', 1], ['idle', 2]]);
  });
});
