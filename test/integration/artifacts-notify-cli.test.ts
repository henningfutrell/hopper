// Issue #673: a new artifact reaches the person through their notifier, with its link; the operator CLI lists, reads,
// shares, revokes and removes artifacts (issue #623: JSON out). The real daemon, a joined machine, the real
// `hopper-artifact`, the built-in Grok Bot routine notifier with a loopback receiver, and the real `hopper` CLI.
//
// Feature: notify and CLI
//   Scenario: `artifact.created` sends a notification with the artifact's link
//     Given the Grok Bot routine is configured
//     When a job puts an artifact
//     Then the routine receives `artifact.created` with its id, title, type, the job's issue and its link
//   Scenario: the operator CLI lists the artifact, reads it, shares it, revokes the share and removes it, as JSON
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { ArtifactView } from '../../src/domain/types.ts';
import { artifactHarness, ISSUE } from '../support/artifacts.ts';
import { databaseUrlFor } from '../support/database.ts';
import type { TestApp } from '../support/app.ts';
import { waitFor } from '../support/wait.ts';

const h = artifactHarness();
let server: Server | undefined;
afterEach(async () => {
  await h.stop();
  const s = server;
  if (s) await new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); });
  server = undefined;
});

async function receiver(): Promise<{ url: string; hits: Record<string, unknown>[] }> {
  const hits: Record<string, unknown>[] = [];
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { hits.push(JSON.parse(raw) as Record<string, unknown>); res.end(); });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/routine`, hits };
}

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url], io);
  return { code, out: out.join(''), err: err.join('') };
}

async function put(a: TestApp, job: string): Promise<ArtifactView> {
  const { dir } = h.file('chart.html', '<!doctype html><p>42</p>\n');
  const r = await h.artifact(a, job, ['put', 'chart.html', '--title', 'Queue wait', '--json'], { cwd: dir });
  return (JSON.parse(r.stdout) as { artifact: ArtifactView }).artifact;
}

describe('artifacts: notify and CLI (issue #673)', () => {
  it('`artifact.created` sends a notification through the routine, with the artifact\'s link', async () => {
    const r = await receiver();
    const { a, job } = await h.boot({ secrets: { GROKBOT_WEBHOOK_URL: r.url, GROKBOT_WEBHOOK_KEY: 'sekrit' }, seams: { grokbot: { baseMs: 20 } } });
    const art = await put(a, job);
    const hit = await waitFor(() => r.hits.find((x) => x.kind === 'artifact.created'), { what: 'the artifact notification' });
    expect(hit).toMatchObject({
      source: 'hopper', kind: 'artifact.created', jobId: job, artifactId: art.id, title: 'Queue wait', type: 'text/html',
      size: art.size, issueUrl: ISSUE.url, url: `${a.url}/#artifacts/${art.id}`,
    });
  });

  it('the operator CLI lists, reads, shares, revokes and removes artifacts, as JSON', async () => {
    const { a, job } = await h.boot();
    await a.addUser('bob');
    const art = await put(a, job);

    const list = await hopper(a, ['artifact', 'list']);
    expect(list.code).toBe(0);
    const listed = JSON.parse(list.out) as { artifacts: ArtifactView[] };
    expect(listed.artifacts.map((x) => x.id)).toEqual([art.id]);
    expect(listed.artifacts[0]).toMatchObject({ title: 'Queue wait', jobId: job, url: expect.stringContaining(`/#artifacts/${art.id}`) });

    const got = await hopper(a, ['artifact', 'get', art.id]);
    expect(JSON.parse(got.out)).toMatchObject({ id: art.id, shares: [] });

    const shared = await hopper(a, ['artifact', 'share', art.id, '--user', 'bob']);
    expect(shared.code).toBe(0);
    const share = (JSON.parse(shared.out) as { share: { id: string; userName: string } }).share;
    expect(share.userName).toBe('bob');
    const link = await hopper(a, ['artifact', 'share', art.id, '--public', '--hours', '2']);
    expect(JSON.parse(link.out)).toMatchObject({ link: expect.stringContaining('/artifact-link/') });

    const revoked = await hopper(a, ['artifact', 'revoke', art.id, share.id]);
    expect(revoked.code).toBe(0);
    expect((JSON.parse(revoked.out) as { artifact: ArtifactView }).artifact.shares!.find((s) => s.id === share.id)!.revokedAt).toBeDefined();

    expect((await hopper(a, ['artifact', 'share', art.id])).err).toMatch(/usage: hopper artifact share/);
    expect((await hopper(a, ['artifact', 'get', 'no-such'])).code).toBe(2);

    const rm = await hopper(a, ['artifact', 'rm', art.id]);
    expect(JSON.parse(rm.out)).toEqual({ removed: art.id });
    expect(JSON.parse((await hopper(a, ['artifact', 'list'])).out)).toEqual({ artifacts: [] });
  });
});
