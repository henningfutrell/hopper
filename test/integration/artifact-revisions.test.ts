// Issue #675: every change to an artifact is a revision. The real daemon, a joined machine, the real `hopper-artifact`
// run as a job runs it, the UI's routes and the real `hopper` CLI.
//
// Feature: revisions
//   Scenario: a put to an existing artifact makes a new revision; the id and its URL stay, older revisions stay readable
//     Given a job put an artifact, revision 1
//     When a job puts a new file to it with `--to ID --note TEXT`
//     Then it is revision 2 under the same id, and the artifact reads as revision 2
//     And GET /api/artifacts/:id/revisions lists 2 and 1, each with its time, who made it and its note
//     And GET /api/artifacts/:id/revisions/1 opens revision 1's content
//     And `artifact.revised` is on the job's timeline
//   Scenario: restoring an old revision makes it the latest, as a new revision; nothing is overwritten
//   Scenario: a public link follows the latest revision, or pins one with ?revision=N
//   Scenario: revisions count toward the storage quota; the sweep keeps the latest and the pinned ones
//   Scenario: the operator CLI lists the revisions and restores one, as JSON
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import type { ArtifactRevisionView, ArtifactView } from '../../src/domain/types.ts';
import { artifactHarness, eventsOf, readArtifacts as read } from '../support/artifacts.ts';
import { databaseUrlFor } from '../support/database.ts';
import type { TestApp } from '../support/app.ts';

const h = artifactHarness();
afterEach(() => h.stop());

const page = (n: number): string => `<!doctype html><title>Flow ${n}</title><svg viewBox="0 0 10 10"><rect width="${n}" height="10"/></svg>\n`;

async function put(a: TestApp, job: string, body: string, args: string[] = []): Promise<{ artifact: ArtifactView; warning?: string }> {
  const { dir } = h.file('flow.html', body);
  const r = await h.artifact(a, job, ['put', 'flow.html', ...args, '--json'], { cwd: dir });
  expect(r.code, r.stdout).toBe(0);
  return JSON.parse(r.stdout) as { artifact: ArtifactView; warning?: string };
}

const api = async <T>(a: TestApp, session: string, path: string) => a.api<T>('GET', path, undefined, { 'x-hopper-session': session });

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url, '--user', 'admin'], io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('artifact revisions (issue #675)', () => {
  it('a put to an existing artifact makes revision 2 under the same id; revision 1 stays readable', async () => {
    const { a, session, job } = await h.boot();
    const first = (await put(a, job, page(1), ['--title', 'Flow', '--summary', 'How a rerun reads the issue'])).artifact;
    expect(first).toMatchObject({ revision: 1, title: 'Flow', summary: 'How a rerun reads the issue', revisedBy: `job ${job}` });

    const second = await put(a, job, page(2), ['--to', first.id, '--note', 'adds the fixed flow']);
    expect(second.artifact).toMatchObject({ id: first.id, revision: 2, title: 'Flow', summary: 'How a rerun reads the issue', note: 'adds the fixed flow', url: first.url });
    const text = await h.artifact(a, job, ['put', 'flow.html', '--to', first.id], { cwd: h.file('flow.html', page(3)).dir });
    expect(text.stdout).toMatch(new RegExp(`^put: ${first.id} {2}revision 3 {2}Flow {2}text/html {2}\\d+ bytes\\nurl: `));

    const listed = (await read(a, session)).artifacts;
    expect(listed.map((x) => [x.id, x.revision])).toEqual([[first.id, 3]]);
    expect(await (await fetch(a.url + listed[0]!.contentUrl)).text()).toBe(page(3));

    const revs = await api<{ revisions: ArtifactRevisionView[] }>(a, session, `/api/artifacts/${first.id}/revisions`);
    expect(revs.status).toBe(200);
    expect(revs.body.revisions.map((r) => [r.n, r.by, r.note ?? null, r.latest])).toEqual([
      [3, `job ${job}`, null, true], [2, `job ${job}`, 'adds the fixed flow', false], [1, `job ${job}`, null, false],
    ]);
    const one = await api<ArtifactRevisionView>(a, session, `/api/artifacts/${first.id}/revisions/1`);
    expect(one.body).toMatchObject({ artifactId: first.id, n: 1, size: Buffer.byteLength(page(1)) });
    expect(await (await fetch(a.url + one.body.contentUrl)).text()).toBe(page(1));
    expect((await api(a, session, `/api/artifacts/${first.id}/revisions/9`)).status).toBe(404);

    expect(eventsOf(a, 'artifact.revised').map((e) => [e.jobId, (e.data as { revision: number }).revision])).toEqual([[job, 2], [job, 3]]);
    expect(a.user().jobStream.repo.since(job, 0, 100).map((e) => e.type)).toContain('artifact.revised');

    const missing = await h.artifact(a, job, ['put', 'flow.html', '--to', '00000000-0000-4000-8000-000000000000'], { cwd: h.file('flow.html', page(4)).dir });
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(/^no: there is no artifact 00000000-0000-4000-8000-000000000000/);
  });

  it('a restore makes an old revision the latest, as a new revision; a pin keeps a revision from the sweep', async () => {
    const { a, session, job } = await h.boot();
    const id = (await put(a, job, page(1), ['--summary', 'one'])).artifact.id;
    await put(a, job, page(2), ['--to', id]);

    const restored = await a.ui<{ artifact: ArtifactView }>(`/ui/api/artifacts/${id}/restore`, { revision: 1 }, { token: session });
    expect(restored.status).toBe(200);
    expect(restored.body.artifact).toMatchObject({ id, revision: 3, note: 'restored revision 1', revisedBy: 'github:admin' });
    const revs = (await api<{ revisions: ArtifactRevisionView[] }>(a, session, `/api/artifacts/${id}/revisions`)).body.revisions;
    expect(revs.map((r) => [r.n, r.sha256 === revs[2]!.sha256])).toEqual([[3, true], [2, false], [1, true]]);
    expect(eventsOf(a, 'artifact.revised').at(-1)!.data).toMatchObject({ artifact: id, revision: 3, restoredFrom: 1, by: 'github:admin' });
    expect((await a.ui(`/ui/api/artifacts/${id}/restore`, { revision: 7 }, { token: session })).status).toBe(404);

    // Revisions count toward the quota.
    const used = (await read(a, session)).usedBytes;
    expect(used).toBe(Buffer.byteLength(page(1)) * 2 + Buffer.byteLength(page(2)));

    // The sweep: older revisions past the retention go, unless pinned; the latest stays.
    const pinned = await a.ui(`/ui/api/artifacts/${id}/revisions/2/pin`, { pinned: true }, { token: session });
    expect(pinned.status).toBe(200);
    expect(eventsOf(a, 'artifact.revision_pinned').at(-1)!.data).toMatchObject({ artifact: id, revision: 2, pinned: true, by: 'github:admin' });
    a.user().store.db.run('UPDATE artifact_revisions SET created_at = ? WHERE artifact_id = ?', new Date(Date.now() - 40 * 86_400_000).toISOString(), id);
    expect(a.user().artifacts.sweep()).toEqual([]);
    const left = (await api<{ revisions: ArtifactRevisionView[] }>(a, session, `/api/artifacts/${id}/revisions`)).body.revisions;
    expect(left.map((r) => [r.n, r.pinned])).toEqual([[3, false], [2, true]]);
    expect(eventsOf(a, 'artifact.revision_removed').map((e) => e.data)).toEqual([{ artifact: id, revision: 1, reason: 'retention' }]);
  });

  it('a public link follows the latest revision, or pins one with ?revision=N', async () => {
    const { a, job } = await h.boot();
    const id = (await put(a, job, page(1), ['--title', 'Flow', '--summary', 'How a rerun reads the issue'])).artifact.id;
    const made = await h.artifact(a, job, ['share', id, '--public', '--hours', '2']);
    const link = /^link: (\S+)$/m.exec(made.stdout)![1]!;
    await put(a, job, page(2), ['--to', id]);

    expect(await (await fetch(`${link}/content`)).text()).toBe(page(2));
    expect(await (await fetch(`${link}/content?revision=1`)).text()).toBe(page(1));
    const pinned = await (await fetch(`${link}?revision=1`)).text();
    expect(pinned).toContain('Revision 1 of 2');
    expect(pinned).toContain(`/content?revision=1`);
    expect((await fetch(`${link}/content?revision=5`)).status).toBe(404);
  });

  it('the operator CLI lists the revisions and restores one, as JSON', async () => {
    const { a, job } = await h.boot();
    const id = (await put(a, job, page(1))).artifact.id;
    await put(a, job, page(2), ['--to', id, '--note', 'second']);

    const revs = await hopper(a, ['artifact', 'revisions', id]);
    expect(revs.code).toBe(0);
    expect((JSON.parse(revs.out) as { revisions: ArtifactRevisionView[] }).revisions.map((r) => [r.n, r.note ?? null])).toEqual([[2, 'second'], [1, null]]);

    const restored = await hopper(a, ['artifact', 'restore', id, '1']);
    expect(restored.code).toBe(0);
    expect((JSON.parse(restored.out) as { artifact: ArtifactView }).artifact).toMatchObject({ id, revision: 3, note: 'restored revision 1' });
    expect((await hopper(a, ['artifact', 'restore', id])).err).toMatch(/usage: hopper artifact restore/);
  });
});
