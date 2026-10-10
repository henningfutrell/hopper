// Issue #687: one piece of work is one artifact. Three jobs once made three artifacts of one walk-through, because only a
// running job could add a revision. Now the owner revises an artifact from the UI or the operator CLI, merges artifacts
// into one, and a job's put that looks like a revision of an artifact the user has is kept, with a warning. The real
// daemon, a joined machine, the real `hopper-artifact` run as a job runs it, the UI's routes and the real `hopper` CLI.
//
// Feature: owner revise, merge, duplicate puts
//   Scenario: the owner revises an artifact with a file, or with another artifact's latest content
//     Given a job put an artifact
//     When the owner posts a file, or `from` another artifact, to /ui/api/artifacts/:id/revisions
//     Then it is the next revision, `revisedBy` the owner, the source left as it was
//   Scenario: a merge adds each source's revisions to the target, oldest first, then removes the source
//     Then the content and the job that made each revision are kept, each with the note "merged from <id>"
//     And the newest is the latest, `artifact.revised` (with `mergedFrom`) then `artifact.removed` (reason `merged`)
//   Scenario: a merge that does not fit the quota changes nothing: the source stays
//   Scenario: a put without --to that looks like a revision of an artifact is kept, with a warning; --new silences it
//   Scenario: the operator CLI revises and merges, as JSON, and its URLs use the link base jobs use
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../../src/cli.ts';
import { ARTIFACT_HELP } from '../../src/artifacts/script.ts';
import type { ArtifactRevisionView, ArtifactView } from '../../src/domain/types.ts';
import { artifactHarness, eventsOf, readArtifacts as read } from '../support/artifacts.ts';
import { databaseUrlFor } from '../support/database.ts';
import type { TestApp } from '../support/app.ts';

const h = artifactHarness();
afterEach(() => h.stop());

const page = (n: number): string => `<!doctype html><title>Flow ${n}</title><svg viewBox="0 0 10 10"><rect width="${n}" height="10"/></svg>\n`;

async function put(a: TestApp, job: string, name: string, body: string, args: string[] = []): Promise<{ artifact: ArtifactView; warning?: string }> {
  const { dir } = h.file(name, body);
  const r = await h.artifact(a, job, ['put', name, ...args, '--json'], { cwd: dir });
  expect(r.code, r.stdout).toBe(0);
  return JSON.parse(r.stdout) as { artifact: ArtifactView; warning?: string };
}

const revisionsOf = async (a: TestApp, session: string, id: string): Promise<ArtifactRevisionView[]> =>
  (await a.api<{ revisions: ArtifactRevisionView[] }>('GET', `/api/artifacts/${id}/revisions`, undefined, { 'x-hopper-session': session })).body.revisions;
const textOf = async (a: TestApp, url: string): Promise<string> => (await fetch(a.url + url)).text();

async function hopper(a: TestApp, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env: { HOPPER_DATABASE_URL: databaseUrlFor(a.dbPath) }, stdin: () => '', out: (x) => out.push(x), err: (x) => err.push(x) };
  const code = await runCli([...argv, '--url', a.url, '--user', 'admin'], io);
  return { code, out: out.join(''), err: err.join('') };
}

describe('owner revise (issue #687)', () => {
  it('the owner revises an artifact with a file or with another artifact\'s latest content; revisedBy is the owner', async () => {
    const { a, session, job } = await h.boot();
    const id = (await put(a, job, 'flow.html', page(1), ['--title', 'Flow', '--summary', 'one'])).artifact.id;
    const other = (await put(a, job, 'chart.html', page(7), ['--title', 'Chart', '--new'])).artifact.id;

    const byFile = await a.ui<{ artifact: ArtifactView }>(`/ui/api/artifacts/${id}/revisions`,
      { file: { name: 'flow.html', content: Buffer.from(page(2)).toString('base64') }, note: 'the fixed flow' }, { token: session });
    expect(byFile.status).toBe(200);
    expect(byFile.body.artifact).toMatchObject({ id, revision: 2, title: 'Flow', summary: 'one', note: 'the fixed flow', revisedBy: 'login code' });

    const byFrom = await a.ui<{ artifact: ArtifactView }>(`/ui/api/artifacts/${id}/revisions`, { from: other }, { token: session });
    expect(byFrom.status).toBe(200);
    expect(byFrom.body.artifact).toMatchObject({ id, revision: 3, name: 'chart.html', revisedBy: 'login code', note: `copied from ${other}` });
    expect(await textOf(a, byFrom.body.artifact.contentUrl)).toBe(page(7));
    // The source stays as it was: a revise copies.
    expect((await read(a, session)).artifacts.map((x) => x.id).sort()).toEqual([id, other].sort());

    const revs = await revisionsOf(a, session, id);
    expect(revs.map((r) => [r.n, r.by])).toEqual([[3, 'login code'], [2, 'login code'], [1, `job ${job}`]]);
    expect(eventsOf(a, 'artifact.revised').map((e) => (e.data as { by: string }).by)).toEqual(['login code', 'login code']);

    expect((await a.ui(`/ui/api/artifacts/${id}/revisions`, { from: '00000000-0000-4000-8000-000000000000' }, { token: session })).status).toBe(404);
    expect((await a.ui(`/ui/api/artifacts/${id}/revisions`, { from: id }, { token: session })).status).toBe(400);
    expect((await a.ui(`/ui/api/artifacts/${id}/revisions`, {}, { token: session })).status).toBe(400);
  });
});

describe('merge (issue #687)', () => {
  it('adds each source\'s revisions to the target, oldest first, keeping content and job; then removes the source', async () => {
    const { a, session, job } = await h.boot();
    const into = (await put(a, job, 'flow.html', page(1), ['--title', 'Loop (#662)', '--summary', 'the walk-through'])).artifact.id;
    const b = (await put(a, job, 'seq.html', page(2), ['--title', 'Loop (#662): sequence', '--new'])).artifact.id;
    await put(a, job, 'seq.html', page(3), ['--to', b, '--note', 'adds the fixed flow']);
    const c = (await put(a, job, 'chart.html', page(4), ['--title', 'Loop (#662): interactive', '--new'])).artifact.id;
    const used = (await read(a, session)).usedBytes;

    const merged = await a.ui<{ artifact: ArtifactView; merged: string[] }>(`/ui/api/artifacts/${into}/merge`, { from: [b, c] }, { token: session });
    expect(merged.status).toBe(200);
    expect(merged.body.merged).toEqual([b, c]);
    expect(merged.body.artifact).toMatchObject({ id: into, revision: 4, title: 'Loop (#662): interactive', name: 'chart.html' });

    const revs = await revisionsOf(a, session, into);
    expect(revs.map((r) => [r.n, r.by, r.note ?? null, r.latest])).toEqual([
      [4, `job ${job}`, `merged from ${c}`, true],
      [3, `job ${job}`, `merged from ${b}`, false],
      [2, `job ${job}`, `merged from ${b}`, false],
      [1, `job ${job}`, null, false],
    ]);
    expect(await Promise.all(revs.map((r) => textOf(a, r.contentUrl)))).toEqual([page(4), page(3), page(2), page(1)]);

    // The sources are gone; the bytes moved with their revisions, so the quota holds the same.
    const after = await read(a, session);
    expect(after.artifacts.map((x) => x.id)).toEqual([into]);
    expect(after.usedBytes).toBe(used);

    const events = a.user().store.events.recent(1000).filter((e) => e.type === 'artifact.revised' || e.type === 'artifact.removed').reverse()
      .filter((e) => (e.data as { mergedFrom?: string; reason?: string }).mergedFrom !== undefined || (e.data as { reason?: string }).reason === 'merged')
      .map((e) => [e.type, (e.data as { artifact: string }).artifact, (e.data as { mergedFrom?: string }).mergedFrom ?? (e.data as { reason: string }).reason]);
    expect(events).toEqual([
      ['artifact.revised', into, b], ['artifact.revised', into, b], ['artifact.removed', b, 'merged'],
      ['artifact.revised', into, c], ['artifact.removed', c, 'merged'],
    ]);
    expect(eventsOf(a, 'artifact.removed').map((e) => e.data)).toContainEqual({ artifact: b, reason: 'merged', into, by: 'login code' });
  });

  it('a merge that does not fit the quota changes nothing: the source stays', async () => {
    const { a, session, job } = await h.boot();
    const into = (await put(a, job, 'flow.html', page(1))).artifact.id;
    const b = (await put(a, job, 'big.html', page(2).repeat(50), ['--new'])).artifact.id;
    const repo = a.user().store.artifacts;
    repo.setSettings({ ...repo.settings(), userBytes: repo.usedBytes() + 10 });

    const r = await a.ui<{ error: string }>(`/ui/api/artifacts/${into}/merge`, { from: [b] }, { token: session });
    expect(r.status).toBe(413);
    expect(r.body.error).toMatch(/this user's artifacts hold/);
    expect((await read(a, session)).artifacts.map((x) => x.id).sort()).toEqual([into, b].sort());
    expect((await revisionsOf(a, session, into)).map((x) => x.n)).toEqual([1]);
    expect((await revisionsOf(a, session, b)).map((x) => x.n)).toEqual([1]);
    expect(eventsOf(a, 'artifact.removed')).toEqual([]);

    expect((await a.ui(`/ui/api/artifacts/${into}/merge`, { from: [into] }, { token: session })).status).toBe(400);
    expect((await a.ui(`/ui/api/artifacts/${into}/merge`, { from: ['00000000-0000-4000-8000-000000000000'] }, { token: session })).status).toBe(404);
  });
});

describe('duplicate puts (issue #687)', () => {
  it('a put without --to that looks like a revision is kept, with a warning naming the artifact; --new keeps it separate', async () => {
    const { a, job } = await h.boot({ source: { url: 'https://github.com/octo-org/hello/issues/8', number: 8 } });
    const first = (await put(a, job, 'flow.html', page(1), ['--title', 'Run again loophole (#662)', '--summary', 'one'])).artifact;
    const hint = `looks like a revision of ${first.id} 'Run again loophole (#662)': pass --to ${first.id}, or --new to keep it separate`;

    // The same file name.
    const sameName = await put(a, job, 'flow.html', page(2), ['--title', 'Something else', '--summary', 'two']);
    expect(sameName.artifact.id).not.toBe(first.id);
    expect(sameName.warning).toBe(hint);
    // The same title prefix.
    const samePrefix = await put(a, job, 'seq.html', page(3), ['--title', 'Run again loophole (#662): sequence', '--summary', 'three']);
    expect(samePrefix.warning).toContain(`looks like a revision of `);
    // The same issue reference in the title.
    const sameRef = await put(a, job, 'other.html', page(4), ['--title', 'Rerun fix for #662', '--summary', 'four']);
    expect(sameRef.warning).toMatch(/^looks like a revision of [0-9a-f-]{36} '/);

    // --new: no warning. The text output says the warning too.
    const separate = await put(a, job, 'flow.html', page(5), ['--title', 'Run again loophole (#662)', '--summary', 'five', '--new']);
    expect(separate.warning).toBeUndefined();
    const text = await h.artifact(a, job, ['put', 'flow.html', '--summary', 'six'], { cwd: h.file('flow.html', page(6)).dir });
    expect(text.stdout).toMatch(/^warning: looks like a revision of /m);
    expect(eventsOf(a, 'artifact.created')).toHaveLength(6);

    // Nothing alike: no warning.
    const fresh = await put(a, job, 'queue.html', page(7), ['--title', 'Queue wait', '--summary', 'seven']);
    expect(fresh.warning).toBeUndefined();
  });

  it('the help says to look before a put, and to revise what already shows the work', () => {
    expect(ARTIFACT_HELP).toContain('Before you put, run `list --all`. If an artifact already shows this work, even one another job made, revise it with `put FILE --to ID --note TEXT`.');
    expect(ARTIFACT_HELP).toMatch(/--new/);
  });
});

describe('the operator CLI (issue #687)', () => {
  it('revises with --file or --from and merges, as JSON; its URLs use the link base jobs use, not loopback', async () => {
    const { a, job } = await h.boot({ env: { HOPPER_LAN_NAMES: 'hopper,box.local', HOPPER_LAN_PEERS: '192.0.2.0/24' } });
    const port = new URL(a.url).port;
    const id = (await put(a, job, 'flow.html', page(1))).artifact.id;
    const other = (await put(a, job, 'chart.html', page(2), ['--new'])).artifact.id;
    const third = (await put(a, job, 'map.html', page(3), ['--new'])).artifact.id;

    const got = await hopper(a, ['artifact', 'get', id]);
    expect((JSON.parse(got.out) as ArtifactView).url).toBe(`http://box.local:${port}/#artifacts/${id}`);
    const listed = await hopper(a, ['artifact', 'list']);
    expect((JSON.parse(listed.out) as { artifacts: ArtifactView[] }).artifacts.map((x) => x.url)).toContain(`http://box.local:${port}/#artifacts/${id}`);

    const { path } = h.file('fixed.html', page(9));
    const byFile = await hopper(a, ['artifact', 'revise', id, '--file', path, '--note', 'fixed']);
    expect(byFile.code, byFile.err).toBe(0);
    expect((JSON.parse(byFile.out) as { artifact: ArtifactView }).artifact).toMatchObject({ id, revision: 2, name: 'fixed.html', note: 'fixed', revisedBy: 'operator CLI', url: `http://box.local:${port}/#artifacts/${id}` });

    const byFrom = await hopper(a, ['artifact', 'revise', id, '--from', other]);
    expect((JSON.parse(byFrom.out) as { artifact: ArtifactView }).artifact).toMatchObject({ id, revision: 3, name: 'chart.html' });

    const merged = await hopper(a, ['artifact', 'merge', id, other, third]);
    expect(merged.code, merged.err).toBe(0);
    expect(JSON.parse(merged.out)).toMatchObject({ merged: [other, third], artifact: { id, revision: 5 } });

    expect((await hopper(a, ['artifact', 'revise', id])).err).toMatch(/usage: hopper artifact revise/);
    expect((await hopper(a, ['artifact', 'revise', id, '--file', path, '--from', other])).err).toMatch(/usage: hopper artifact revise/);
    expect((await hopper(a, ['artifact', 'merge', id])).err).toMatch(/usage: hopper artifact merge/);
  });
});
