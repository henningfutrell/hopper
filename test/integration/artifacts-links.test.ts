// Issue #673: an artifact's link opens where the person is. The first real artifact's link named the first LAN name
// (a bare container name), which no LAN client could resolve. Now a person's read builds links from the Host they used;
// a link a job reports uses the user's link base (Settings → Artifacts), or else an IP or `.local` LAN name over a bare
// one. The real daemon, a joined machine and the real `hopper-artifact`.
//
// Feature: links the viewer can open
//   Scenario: a job-reported link names an IP or .local LAN name, and opens from a LAN client
//     Given a hopper whose LAN names are a bare name, a .local name and an IP
//     When a job puts an artifact
//     Then its URL names the .local name with the hopper's port
//     And a LAN client that opens it is served, not refused
//   Scenario: a person's read builds links from the Host they used
//   Scenario: the link base, set in Settings → Artifacts, is what jobs report
//     When an admin sets the link base to an origin the hopper answers to
//     Then the next put reports a URL under it
//     And an origin the hopper does not answer to is refused with the ones it does
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactsView, ArtifactView } from '../../src/domain/types.ts';
import { rawRequest } from '../support/http.ts';
import { artifactHarness } from '../support/artifacts.ts';

const h = artifactHarness();
afterEach(() => h.stop());

const LAN = { HOPPER_LAN_NAMES: 'hopper,box.local,192.0.2.29', HOPPER_LAN_PEERS: '192.0.2.0/24' };

describe('artifact links the viewer can open (issue #673)', () => {
  it('a job-reported link names the .local LAN name over a bare one, and a LAN client that opens it is served', async () => {
    const { a, job } = await h.boot({ env: LAN });
    const port = new URL(a.url).port;
    const { dir } = h.file('notes.md', '# Notes\n');
    const put = await h.artifact(a, job, ['put', 'notes.md', '--json'], { cwd: dir });
    const art = (JSON.parse(put.stdout) as { artifact: ArtifactView }).artifact;
    expect(art.url).toBe(`http://box.local:${port}/#artifacts/${art.id}`);
    // A browser on the LAN opens the link: the page at its Host is served, never refused as misdirected (421).
    const opened = await rawRequest(a.url, { path: '/', headers: { host: new URL(art.url).host } });
    expect([200, 503]).toContain(opened.status);
  });

  it('a person\'s read builds each link from the Host they used', async () => {
    const { a, session, job } = await h.boot({ env: LAN });
    const port = new URL(a.url).port;
    const { dir } = h.file('notes.md', '# Notes\n');
    const id = (JSON.parse((await h.artifact(a, job, ['put', 'notes.md', '--json'], { cwd: dir })).stdout) as { artifact: ArtifactView }).artifact.id;
    const res = await rawRequest(a.url, { path: '/api/artifacts', headers: { host: `192.0.2.29:${port}`, 'x-hopper-session': session } });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.text) as ArtifactsView).artifacts[0]!.url).toBe(`http://192.0.2.29:${port}/#artifacts/${id}`);
    const one = await rawRequest(a.url, { path: `/api/artifacts/${id}`, headers: { host: `hopper:${port}`, 'x-hopper-session': session } });
    expect((JSON.parse(one.text) as ArtifactView).url).toBe(`http://hopper:${port}/#artifacts/${id}`);
  });

  it('the link base set in Settings → Artifacts is what a job reports; one the hopper does not answer to is refused', async () => {
    const { a, session, job } = await h.boot({ env: LAN });
    const port = new URL(a.url).port;
    const set = await a.ui('/ui/api/artifacts/settings', { linkBase: `http://192.0.2.29:${port}` }, { token: session });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ settings: { linkBase: `http://192.0.2.29:${port}` } });
    const { dir } = h.file('notes.md', '# Notes\n');
    const put = await h.artifact(a, job, ['put', 'notes.md'], { cwd: dir });
    expect(put.stdout).toMatch(new RegExp(`^url: http://192\\.0\\.2\\.29:${port}/#artifacts/[0-9a-f-]{36}$`, 'm'));

    const wrong = await a.ui<{ error: string }>('/ui/api/artifacts/settings', { linkBase: 'http://elsewhere.example:4790' }, { token: session });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/the hopper does not answer at http:\/\/elsewhere\.example:4790/);
    expect(wrong.body.error).toContain(`http://box.local:${port}`);
    const path = await a.ui('/ui/api/artifacts/settings', { linkBase: `http://hopper:${port}/x` }, { token: session });
    expect(path.status).toBe(400);

    // Cleared: the default again.
    expect((await a.ui('/ui/api/artifacts/settings', { linkBase: '' }, { token: session })).status).toBe(200);
    const again = await h.artifact(a, job, ['put', 'notes.md'], { cwd: dir });
    expect(again.stdout).toMatch(new RegExp(`^url: http://box\\.local:${port}/`, 'm'));
  });
});
