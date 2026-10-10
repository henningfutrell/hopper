// Issue #624: the UI's artifacts model — a job's artifacts, the ones a text links to (a proposal or report embeds them),
// sizes and shares in words, and how each kind is previewed.
import { describe, expect, it } from 'vitest';
import { artifactsOfJob, bytesInWords, previewOf, referencedArtifacts, shareInWords } from '../../ui/src/model/artifacts.ts';
import type { ArtifactsView, ArtifactView } from '../../ui/src/model/wire.ts';

const ID1 = '0722a67b-8c7c-4315-8582-8794aa7b9dbc';
const ID2 = '1a2b3c4d-0000-4000-8000-000000000624';

const art = (id: string, jobId: string, over: Partial<ArtifactView> = {}): ArtifactView => ({
  id, userId: 'admin', jobId, title: id, name: 'chart.html', type: 'text/html', kind: 'html', size: 10, sha256: 'x',
  createdAt: '2026-10-10T00:00:00.000Z', url: `http://h/#artifacts/${id}`, contentUrl: `/artifact-content/chart.html?v=t-${id}`, ...over,
});

describe('artifacts in the UI (issue #624)', () => {
  it('lists a job\'s artifacts, its own and those shared with the person', () => {
    const view: ArtifactsView = { artifacts: [art(ID1, 'j1'), art('other', 'j2')], shared: [art(ID2, 'j1', { owner: 'bob' })], usedBytes: 20, settings: {} as ArtifactsView['settings'] };
    expect(artifactsOfJob(view, 'j1').map((a) => a.id)).toEqual([ID1, ID2]);
    expect(artifactsOfJob(null, 'j1')).toEqual([]);
  });

  it('finds the artifacts a text links to by their stable URL, each once, in order', () => {
    expect(referencedArtifacts(`See http://h:4790/#artifacts/${ID2} and #artifacts/${ID1}, again #artifacts/${ID2}.`)).toEqual([ID2, ID1]);
    expect(referencedArtifacts('no link here')).toEqual([]);
  });

  it('says sizes and shares in words', () => {
    expect(bytesInWords(512)).toBe('512 B');
    expect(bytesInWords(2048)).toBe('2 KB');
    expect(bytesInWords(10 * 1024 * 1024)).toBe('10 MB');
    const now = Date.parse('2026-10-10T10:00:00.000Z');
    const base = { id: 's', artifactId: ID1, createdAt: '', createdBy: 'x' };
    expect(shareInWords({ ...base, kind: 'user', userName: 'bob' }, now)).toBe('bob');
    expect(shareInWords({ ...base, kind: 'link', expiresAt: '2026-10-10T13:00:00.000Z' }, now)).toBe('public link, 3 h left');
    expect(shareInWords({ ...base, kind: 'link', expiresAt: '2026-10-10T09:00:00.000Z' }, now)).toBe('public link, expired');
    expect(shareInWords({ ...base, kind: 'user', userName: 'bob', revokedAt: '2026-10-10T09:00:00.000Z' }, now)).toBe('bob, revoked');
  });

  it('previews each kind its own way: HTML in a sandboxed frame, images inline, the text kinds read', () => {
    expect(previewOf('html')).toBe('frame');
    expect(previewOf('svg')).toBe('image');
    expect(previewOf('image')).toBe('image');
    expect(previewOf('pdf')).toBe('pdf');
    expect(previewOf('csv')).toBe('csv');
    expect(previewOf('markdown')).toBe('markdown');
    expect(previewOf('json')).toBe('text');
    expect(previewOf('file')).toBe('none');
  });
});
