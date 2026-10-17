// A job's trace reaches its machine (issue #1486 part 4, design.md "Telemetry: a job's trace on its machine"). The daemon,
// store and HTTP edge are real; telemetry is on with in-memory exporters; GitHub is a fake on loopback; the job's machine
// is a double at the MachineShell port, and the job runs the real `hopper-gh` script against the hopper.
//
// Feature: a job's work joins its trace
//   Scenario: a running job's variables carry its run span, and its request to the hopper is a child of it
//     Given telemetry on, and a job running on a machine
//     Then the job runs with TRACEPARENT naming its run span, in its job's trace
//     When the job runs `sh "$HOPPER_GH" issue view …`
//     Then the hopper's span for `POST /job/github` is a child of the job's run span, in the same trace
//     And the job's git sends the same trace parent to the hopper's git route only (part 6)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_ID } from '../../src/domain/types.ts';
import { startTelemetry, type Telemetry } from '../../src/telemetry/sdk.ts';
import { createFakeGitHub } from '../support/fake-forges.ts';
import { connectGitHub } from '../support/github-account.ts';
import { startTestApp, tempDbPath, type TestApp } from '../support/app.ts';
import { holder, hopperGh } from '../support/job-holder.ts';
import { waitFor } from '../support/wait.ts';

const apps: TestApp[] = [];
const cleanups: (() => unknown)[] = [];
let telemetry: Telemetry | undefined;
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  for (const c of cleanups.splice(0)) await c();
  await telemetry?.shutdown();
  telemetry = undefined;
});

describe('a job\'s trace reaches its machine (issue #1486)', () => {
  it('runs the job with TRACEPARENT of its run span, and its hopper-gh request is a child span of it', async () => {
    const spans = new InMemorySpanExporter();
    telemetry = startTelemetry({ env: {}, version: '0.0.0-test', spanProcessors: [new SimpleSpanProcessor(spans)] });
    const github = await createFakeGitHub({ clientId: 'gh-client-id', issues: [{ repo: 'octo/tools', number: 1, title: 'x', body: 'y', author: 'octo-user', labels: [] }] });
    cleanups.push(() => github.close());
    github.tokens.set('test-account-token', 'owner');
    const db = tempDbPath();
    cleanups.push(db.cleanup);
    const root = mkdtempSync(join(tmpdir(), 'hopper-trace-machine-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const h = holder(root);
    cleanups.push(() => { for (const j of h.held.values()) j.end(); });
    const app = await startTestApp({
      dbPath: db.dbPath, seams: { executors: [h.executor] }, plugins: { executors: [{ name: 'test', plugin: 'test' }] },
      env: { HOPPER_GITHUB_URL: github.url, HOPPER_GITHUB_CLIENT_ID: 'gh-client-id', HOPPER_GITHUB_APP_SLUG: 'hopper-test' },
    });
    apps.push(app);
    connectGitHub(app, ['octo/tools']);

    const job = await app.pull({}, { executor: 'holder', repo: 'octo/tools' }, ADMIN_ID);
    const env = await waitFor(async () => h.held.get(job.id)?.env, { what: `job ${job.id} to run` });
    const [, traceId, runSpanId] = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(env.TRACEPARENT ?? '') ?? [];
    expect(traceId).toBeDefined();
    // Part 6: the job's git sends the same trace parent to the hopper's git route, and to nothing else.
    const gitHeader = (url: string) => spawnSync('/usr/bin/git', ['config', '--get-urlmatch', 'http.extraheader', url], { env: { PATH: process.env.PATH, HOME: '/nonexistent', GIT_CONFIG_NOSYSTEM: '1', ...env }, encoding: 'utf8' }).stdout.trim();
    expect(gitHeader(`${env.HOPPER_URL}/job/git/octo/tools.git`)).toBe(`traceparent: ${env.TRACEPARENT}`);
    expect(gitHeader(`${github.url}/octo/tools.git`)).toBe('');

    const r = await hopperGh(root, env, ['issue', 'view', '1', '--repo', 'octo/tools']);
    expect(r).toMatchObject({ code: 0 });
    const request = await waitFor(async () => spans.getFinishedSpans().find((s) => s.name === 'POST /job/github'), { what: 'the request span' });
    expect(request.spanContext().traceId).toBe(traceId);
    expect(request.parentSpanContext?.spanId).toBe(runSpanId);

    h.held.get(job.id)!.end();
    const run = await waitFor(async () => spans.getFinishedSpans().find((s) => s.name === 'hopper.job.run'), { what: 'the run span to end' });
    expect(run.spanContext()).toMatchObject({ traceId, spanId: runSpanId });
  });
});
