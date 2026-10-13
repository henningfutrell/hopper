// Issue #712: the host link base, the address people open, apart from the LAN names containers use. On a hopper in a
// container its first LAN name is the container's bare name (`hopper`), which only the container network resolves: a
// notification's question link and an artifact's link named it, and did not open on the computer that runs the hopper.
// The real daemon, the real `hopper-artifact`.
//
// Feature: a person's link opens on the computer that runs the hopper
//   Scenario: by default a person's link is http://localhost:<port>, never the container's bare name
//   Scenario: the admin sets the host link base in Settings, and a person's links use it
//   Scenario: a host link base the hopper does not answer at is refused; empty is the default again
//   Scenario: only the instance admin changes it
import { afterEach, describe, expect, it } from 'vitest';
import type { ArtifactView, HostLinkView } from '../../src/domain/types.ts';
import { artifactHarness } from '../support/artifacts.ts';

const h = artifactHarness();
afterEach(() => h.stop());

// As compose.yaml sets them: the container's bare name, for containers and boxes (issue #711).
const CONTAINER = { HOPPER_LAN_NAMES: 'hopper', HOPPER_LAN_PEERS: '192.0.2.0/24' };

describe('the host link base (issue #712)', () => {
  it('by default a person\'s link is http://localhost:<port>, never the container\'s bare name', async () => {
    const { a, job } = await h.boot({ env: CONTAINER });
    const port = new URL(a.url).port;
    expect((await a.api('GET', '/api/host-link')).body).toEqual({ hostLinkBase: '', default: `http://localhost:${port}` } satisfies HostLinkView);
    expect(a.app.answerUrl('q1')).toBe(`http://localhost:${port}/#question-q1`);
    const { dir } = h.file('notes.md', '# Notes\n');
    const put = await h.artifact(a, job, ['put', 'notes.md', '--json'], { cwd: dir });
    const art = (JSON.parse(put.stdout) as { artifact: ArtifactView }).artifact;
    expect(art.url).toBe(`http://localhost:${port}/#artifacts/${art.id}`);
  });

  it('the admin sets it in Settings, and a person\'s links use it; one the hopper does not answer at is refused', async () => {
    const { a, session, job } = await h.boot({ env: CONTAINER });
    const port = new URL(a.url).port;
    const set = await a.ui<HostLinkView>('/ui/api/host-link', { hostLinkBase: `http://127.0.0.1:${port}/` }, { token: session });
    expect(set.status).toBe(200);
    expect(set.body).toEqual({ hostLinkBase: `http://127.0.0.1:${port}`, default: `http://localhost:${port}` });
    expect(a.app.answerUrl('q1')).toBe(`http://127.0.0.1:${port}/#question-q1`);
    const { dir } = h.file('notes.md', '# Notes\n');
    const put = await h.artifact(a, job, ['put', 'notes.md'], { cwd: dir });
    expect(put.stdout).toMatch(new RegExp(`^url: http://127\\.0\\.0\\.1:${port}/#artifacts/[0-9a-f-]{36}$`, 'm'));

    const wrong = await a.ui<{ error: string }>('/ui/api/host-link', { hostLinkBase: 'http://elsewhere.example:4790' }, { token: session });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/the hopper does not answer at http:\/\/elsewhere\.example:4790/);
    expect((await a.ui('/ui/api/host-link', { hostLinkBase: `http://localhost:${port}/x` }, { token: session })).status).toBe(400);
    expect((await a.api('GET', '/api/host-link')).body).toMatchObject({ hostLinkBase: `http://127.0.0.1:${port}` });

    // Cleared: the default again.
    expect((await a.ui('/ui/api/host-link', { hostLinkBase: '' }, { token: session })).status).toBe(200);
    expect(a.app.answerUrl('q1')).toBe(`http://localhost:${port}/#question-q1`);
  });

  it('only the instance admin changes it', async () => {
    const { a } = await h.boot({ env: CONTAINER });
    expect((await a.ui('/ui/api/host-link', { hostLinkBase: '' })).status).toBe(403);
  });
});
