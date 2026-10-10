// Issue #624: a job puts a file on the hopper for a person to see, and shares it. The daemon, store, HTTP edge and a
// joined client are real; OpenFGA is a double at the AuthorizationServer seam. The job runs the real `hopper-artifact`
// script (sh, curl and od) against the hopper, with its own proxy token (issue #563).
//
// Feature: artifacts
//   Scenario: a job makes an HTML chart and gets a URL
//     Given a job running on a machine
//     When the job runs `sh "$HOPPER_ARTIFACT" put chart.html --title "Queue wait" --json`
//     Then it exits 0 with the artifact's id and its stable URL
//     And the artifact records its job, its issue, its user, its type, its size, its hash and when it was made
//     And `artifact.created` is on the job's timeline and on its job stream
//   Scenario: the chart opens sandboxed
//     When the person opens the artifact's content URL
//     Then the HTML is served under a CSP sandbox that runs its scripts but gives it no origin of the hopper and no fetch
//     And it loads nothing from outside: scripts, styles, images and fonts only inline, data: or blob: (issue #673)
//   Scenario: a share link works for another user and stops after a revoke
//     Given a second user of the hopper
//     When the job runs `share ID --user bob`
//     Then bob sees the artifact in GET /api/artifacts and its content loads for him
//     When the share is revoked
//     Then bob no longer sees it, and the content URL he was given no longer loads
//   Scenario: a public link works without a session, expires, and stops when public links are turned off
//   Scenario: limits and masking: a file over the limit is a clear no; a GitHub token in a text artifact is masked
//   Scenario: a token that is no job's, and an unknown artifact, are clear noes; rm removes the artifact
//
// Feature: artifacts are visuals (issue #675)
//   Scenario: an HTML artifact with no drawing gets a warning
//     When the job puts an HTML page with no <svg>, <canvas> or <img>
//     Then the hopper keeps it, and the put answers a warning that the artifact has no visual
//     And `artifact.created` carries the warning, on the job's timeline and its job stream
//   Scenario: an SVG drawing is served in the HTML sandbox
//     When the job puts an SVG with `--type svg`
//     Then it has no warning, and it is served under the same sandbox policy as HTML
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { htmlPolicy } from '../../src/artifacts/content.ts';
import { visualWarning } from '../../src/domain/artifacts.ts';
import type { ArtifactView } from '../../src/domain/types.ts';
import { artifactHarness, eventsOf, readArtifacts as read } from '../support/artifacts.ts';
import type { TestApp } from '../support/app.ts';

const CHART = '<!doctype html><title>Queue wait</title><svg viewBox="0 0 10 10"><rect width="4" height="10"/></svg><div id="c"></div><script>document.getElementById("c").textContent = "42";</script>\n';
const GH_TOKEN = `ghp_${'a1B2'.repeat(9)}`;

const h = artifactHarness();
const { boot, artifact, file } = h;
afterEach(() => h.stop());

const load = (a: TestApp, path: string) => fetch(a.url + path);

describe('artifacts (issue #624)', () => {
  it('a job puts an HTML chart and gets a URL; it is recorded with its job, issue and hash; it opens sandboxed', async () => {
    const { a, session, job } = await boot();
    const { dir } = file('chart.html', CHART);
    const put = await artifact(a, job, ['put', 'chart.html', '--title', 'Queue wait — by hour', '--json'], { cwd: dir });
    expect(put).toMatchObject({ code: 0 });
    const out = JSON.parse(put.stdout) as { ok: boolean; artifact: ArtifactView };
    expect(out.ok).toBe(true);
    expect(out.artifact).toMatchObject({
      jobId: job, userId: a.user().user.id, title: 'Queue wait — by hour', name: 'chart.html', type: 'text/html', kind: 'html',
      size: Buffer.byteLength(CHART), issue: { url: 'https://github.com/octo-org/hello/issues/7', ref: 'octo-org/hello#7' },
      url: `${a.url}/#artifacts/${out.artifact.id}`,
    });
    expect(out.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);

    const text = await artifact(a, job, ['put', 'chart.html', '--summary', 'Queue wait by hour'], { cwd: dir });
    expect(text.code).toBe(0);
    expect(text.stdout).toMatch(/^put: [0-9a-f-]{36} {2}chart\.html {2}text\/html {2}\d+ bytes\nurl: http:\/\/127\.0\.0\.1:\d+\/#artifacts\/[0-9a-f-]{36}\n$/);

    // On the job's timeline, and on its job stream.
    expect(eventsOf(a, 'artifact.created')).toEqual(expect.arrayContaining([expect.objectContaining({ jobId: job, data: expect.objectContaining({ artifact: out.artifact.id, type: 'text/html', issue: 'https://github.com/octo-org/hello/issues/7' }) })]));
    expect(a.user().jobStream.repo.since(job, 0, 100).map((e) => e.type)).toContain('artifact.created');

    // The person reads it and opens it: HTML runs only in a sandbox with no origin of the hopper's and no fetch.
    const view = await read(a, session);
    const mine = view.artifacts.find((x) => x.id === out.artifact.id)!;
    expect(mine.shares).toEqual([]);
    const res = await load(a, mine.contentUrl);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(CHART);
    const csp = res.headers.get('content-security-policy')!;
    expect(csp).toMatch(/^sandbox allow-scripts/);
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("connect-src 'none'");
    // Issue #673: nothing loads from outside, so nothing leaves through a request either — its own signed URL included.
    expect(csp).not.toContain('https:');
    expect(csp).not.toContain('allow-popups-to-escape-sandbox');
    for (const d of ['style-src', 'img-src', 'font-src']) expect(csp).toContain(`${d} 'unsafe-inline' data: blob:;`);
    // Scripts: what the page carries, and the libraries the hopper bundles, from the hopper itself (issue #675).
    expect(csp).toContain(`script-src 'unsafe-inline' data: blob: ${a.url}/artifact-lib/;`);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    // A content URL whose signature is changed loads nothing.
    expect((await load(a, mine.contentUrl.replace(/\.[A-Za-z0-9_-]+$/, '.x'))).status).toBe(404);
  });

  it('a share with another user works for them, and stops working after a revoke', async () => {
    const { a, session, job } = await boot();
    const bob = await a.addUser('bob');
    const bobSession = await a.login(bob.id);
    const { dir } = file('chart.html', CHART);
    const id = (JSON.parse((await artifact(a, job, ['put', 'chart.html', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView }).artifact.id;

    expect((await read(a, bobSession)).shared).toEqual([]);
    expect((await a.api('GET', `/api/artifacts/${id}`, undefined, { 'x-hopper-session': bobSession })).status).toBe(404);

    const shared = await artifact(a, job, ['share', id, '--user', 'bob', '--json']);
    expect(shared.code).toBe(0);
    const share = (JSON.parse(shared.stdout) as { share: { id: string; kind: string; userName: string } }).share;
    expect(share).toMatchObject({ kind: 'user', userName: 'bob' });
    expect(eventsOf(a, 'artifact.shared')).toEqual([expect.objectContaining({ jobId: job, data: expect.objectContaining({ artifact: id, with: 'user', user: 'bob', by: `job ${job}` }) })]);

    const forBob = (await read(a, bobSession)).shared;
    expect(forBob).toEqual([expect.objectContaining({ id, owner: 'admin', title: 'chart.html' })]);
    expect(forBob[0]!.shares).toBeUndefined();
    const url = forBob[0]!.contentUrl;
    expect((await load(a, url)).status).toBe(200);

    // The owner revokes it in the UI.
    const revoked = await a.ui(`/ui/api/artifacts/${id}/shares/${share.id}/revoke`, {}, { token: session });
    expect(revoked.status).toBe(200);
    expect((await read(a, bobSession)).shared).toEqual([]);
    expect((await load(a, url)).status).toBe(403);
    expect(eventsOf(a, 'artifact.share_revoked')).toEqual([expect.objectContaining({ data: expect.objectContaining({ artifact: id, share: share.id, with: 'user' }) })]);
  });

  it('a public link works without a session, and stops after a revoke or when public links are turned off', async () => {
    const { a, session, job } = await boot();
    const { dir } = file('notes.md', '# Findings\n\nAll good.\n');
    const id = (JSON.parse((await artifact(a, job, ['put', 'notes.md', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView }).artifact.id;

    const made = await artifact(a, job, ['share', id, '--public', '--hours', '2']);
    expect(made.code).toBe(0);
    const link = /^link: (\S+)$/m.exec(made.stdout)![1]!;
    expect(link).toMatch(/\/artifact-link\//);
    // The link opens the share page (issue #675); the content is under it.
    expect((await fetch(link)).status).toBe(200);
    const res = await fetch(`${link}/content`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('# Findings\n\nAll good.\n');
    // Only the hash of the link is kept, and no event says it.
    expect(JSON.stringify(a.user().store.events.since(0, 100_000))).not.toContain(link.split('/').at(-1));

    const tooLong = await artifact(a, job, ['share', id, '--public', '--hours', '10000']);
    expect(tooLong.code).toBe(1);
    expect(tooLong.stdout).toMatch(/^no: a public link works for 1 to 168 hours/);

    expect((await a.ui('/ui/api/artifacts/settings', { publicLinks: false }, { token: session })).status).toBe(200);
    expect((await fetch(link)).status).toBe(404);
    expect((await artifact(a, job, ['share', id, '--public'])).stdout).toMatch(/^no: public links are turned off/);
    await a.ui('/ui/api/artifacts/settings', { publicLinks: true }, { token: session });
    expect((await fetch(link)).status).toBe(200);

    const shareId = (await read(a, session)).artifacts[0]!.shares![0]!.id;
    const revoke = await artifact(a, job, ['share', id, '--revoke', shareId]);
    expect(revoke.code).toBe(0);
    expect((await fetch(link)).status).toBe(404);
  });

  it('a file over the limit is a clear no; a GitHub token in a text artifact is masked; rm removes it; a token that is no job\'s gets nothing', async () => {
    const { a, session, job } = await boot();
    expect((await a.ui('/ui/api/artifacts/settings', { maxBytes: 2048 }, { token: session })).status).toBe(200);
    const big = file('big.png', Buffer.alloc(4096, 1));
    const over = await artifact(a, job, ['put', 'big.png', '--json'], { cwd: big.dir });
    expect(over.code).toBe(1);
    expect(JSON.parse(over.stdout)).toEqual({ ok: false, error: expect.stringMatching(/^big\.png is 4096 bytes; one artifact may be at most 2048 bytes/) });

    const png = file('dot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x00, 0x10]));
    const image = JSON.parse((await artifact(a, job, ['put', 'dot.png', '--json'], { cwd: png.dir })).stdout) as { artifact: ArtifactView };
    expect(image.artifact).toMatchObject({ type: 'image/png', kind: 'image', size: 12 });
    const got = file('x', '');
    expect((await artifact(a, job, ['get', image.artifact.id, '--out', join(got.dir, 'copy.png')])).code).toBe(0);
    expect(readFileSync(join(got.dir, 'copy.png'))).toEqual(readFileSync(png.path));

    const log = file('run.log', `token=${GH_TOKEN}\n`);
    const masked = JSON.parse((await artifact(a, job, ['put', 'run.log', '--json'], { cwd: log.dir })).stdout) as { artifact: ArtifactView };
    const body = await (await load(a, (await read(a, session)).artifacts.find((x) => x.id === masked.artifact.id)!.contentUrl)).text();
    expect(body).not.toContain(GH_TOKEN);
    expect(body).toMatch(/^token=ghp_\*+ \(masked\)\n$/);
    expect(eventsOf(a, 'artifact.created').find((e) => (e.data as { artifact: string }).artifact === masked.artifact.id)!.data).toMatchObject({ masked: 1 });

    const list = await artifact(a, job, ['list']);
    expect(list.stdout.trim().split('\n')).toHaveLength(2);
    const md = await artifact(a, job, ['list', '--markdown']);
    expect(md.stdout).toContain('- run.log (an artifact on the hopper)');

    const rm = await artifact(a, job, ['rm', masked.artifact.id]);
    expect(rm).toMatchObject({ code: 0 });
    expect((await read(a, session)).artifacts.map((x) => x.id)).toEqual([image.artifact.id]);
    expect(eventsOf(a, 'artifact.removed')).toEqual([expect.objectContaining({ data: { artifact: masked.artifact.id, reason: 'removed', by: `job ${job}` } })]);

    const missing = await artifact(a, job, ['get', masked.artifact.id]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(/^no: there is no artifact /);
    const stranger = await artifact(a, job, ['list'], { token: 'not-a-token' });
    expect(stranger.code).toBe(1);
    expect(stranger.stdout).toMatch(/^no: the token is not a job's of this hopper/);
    const bad = await artifact(a, job, ['put']);
    expect(bad.code).toBe(2);
  });

  it('the retention sweep removes what is older than the user keeps', async () => {
    const { a, session, job } = await boot();
    const old = new Date(Date.now() - 2 * 86_400_000).toISOString();
    a.user().store.artifacts.add({ id: 'old-1', userId: a.user().user.id, jobId: job, title: 'old', name: 'old.txt', type: 'text/plain', kind: 'text', size: 3, sha256: 'x', createdAt: old, revision: 1, updatedAt: old, revisedBy: `job ${job}`, pinned: false }, Buffer.from('old'));
    const { dir } = file('new.txt', 'new\n');
    const id = (JSON.parse((await artifact(a, job, ['put', 'new.txt', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView }).artifact.id;
    expect(a.user().artifacts.sweep()).toEqual([]);
    expect((await a.ui('/ui/api/artifacts/settings', { retentionDays: 1 }, { token: session })).status).toBe(200);
    expect(a.user().artifacts.sweep()).toEqual(['old-1']);
    expect((await read(a, session)).artifacts.map((x) => x.id)).toEqual([id]);
    expect(eventsOf(a, 'artifact.removed')).toEqual([expect.objectContaining({ data: { artifact: 'old-1', reason: 'retention' } })]);
    expect(eventsOf(a, 'artifact.settings_changed')).toEqual([expect.objectContaining({ data: expect.objectContaining({ to: expect.objectContaining({ retentionDays: 1 }) }) })]);
  });
});

describe('artifacts are visuals (issue #675)', () => {
  it('finds a visual in HTML: <svg>, <canvas> or <img>, in any case; only HTML is checked', () => {
    expect(visualWarning('html', Buffer.from('<p>steps</p><ol><li>one</li></ol>'))).toMatch(/^the artifact has no visual/);
    expect(visualWarning('html', Buffer.from('<p>a</p><SVG viewBox="0 0 1 1"></SVG>'))).toBeUndefined();
    expect(visualWarning('html', Buffer.from('<canvas id="c"></canvas>'))).toBeUndefined();
    expect(visualWarning('html', Buffer.from('<img src="data:image/png;base64,AA">'))).toBeUndefined();
    // A word in the text is not a drawing.
    expect(visualWarning('html', Buffer.from('<p>use an svg or a canvas</p>'))).toMatch(/^the artifact has no visual/);
    expect(visualWarning('svg', Buffer.from('<svg/>'))).toBeUndefined();
    expect(visualWarning('csv', Buffer.from('a,b'))).toBeUndefined();
  });

  it('an HTML page with no drawing is kept with a warning on the put and on the timeline; an SVG has none and opens in the HTML sandbox', async () => {
    const { a, session, job } = await boot();
    const page = file('notes.html', '<!doctype html><title>Notes</title><ol><li>person edits</li><li>hopper re-reads</li></ol>\n');
    const put = await artifact(a, job, ['put', 'notes.html'], { cwd: page.dir });
    expect(put.code).toBe(0);
    expect(put.stdout).toMatch(/\nwarning: the artifact has no visual[^\n]*\n$/);
    const json = JSON.parse((await artifact(a, job, ['put', 'notes.html', '--json'], { cwd: page.dir })).stdout) as { artifact: ArtifactView; warning?: string };
    expect(json.warning).toMatch(/^the artifact has no visual/);
    expect(eventsOf(a, 'artifact.created').find((e) => (e.data as { artifact: string }).artifact === json.artifact.id)!.data).toMatchObject({ warning: json.warning });
    expect(a.user().jobStream.repo.since(job, 0, 100).filter((e) => e.type === 'artifact.created').length).toBe(2);

    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40"><rect width="60" height="40" fill="#4a7"/><script>document.querySelector("rect").setAttribute("width","70")</script></svg>\n';
    const drawing = file('flow.xml', svg);
    const out = JSON.parse((await artifact(a, job, ['put', 'flow.xml', '--type', 'svg', '--summary', 'A flow', '--json'], { cwd: drawing.dir })).stdout) as { artifact: ArtifactView; warning?: string };
    expect(out.artifact).toMatchObject({ type: 'image/svg+xml', kind: 'svg' });
    expect(out.warning).toBeUndefined();
    expect(eventsOf(a, 'artifact.created').find((e) => (e.data as { artifact: string }).artifact === out.artifact.id)!.data).not.toHaveProperty('warning');

    const mine = (await read(a, session)).artifacts.find((x) => x.id === out.artifact.id)!;
    const res = await load(a, mine.contentUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-security-policy')).toBe(htmlPolicy(a.url));
    expect(await res.text()).toBe(svg);
  });
});
