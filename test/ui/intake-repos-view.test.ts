// @vitest-environment happy-dom
// Issue #1463 in the UI: a source whose job repositories are several lists issues of each. Each row says its issue as
// owner/repo#number, and that reference is a link to the issue on GitHub; with issues of more than one repository the panel
// filters them by repository; and Not assigned to you says why its issues are not taken.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DETAIL, SOURCES, boot, button, click, group, posts, row, streamed, unmount, url, view } from './intake-view-harness.ts';

afterEach(unmount);

const notAssigned = (n: number, repo: string) => ({ key: url(n, repo), title: `Nobody has ${n}`, repo, reason: 'not assigned to you', action: 'assign', group: 'not-assigned' });
const TWO_REPOS = [
  { ...SOURCES[0], detail: { ...DETAIL, intake: [...DETAIL.intake, notAssigned(21, 'octo-user/tempest'), notAssigned(22, 'octo-user/tempest')] } },
];

describe('Intake names each issue\'s repository (issue #1463)', () => {
  it('a row says owner/repo#number, as a link to the issue on GitHub', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    const ref = row(view()!, url(3)).querySelector<HTMLElement>('[data-intake-ref]')!;
    expect(ref.textContent).toBe('octo-user/hopper#3');
    const link = ref.closest('a')!;
    expect(link.getAttribute('href')).toBe(url(3));
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.textContent).toContain('Nobody has it');
  });

  it('Not assigned to you says why its issues are not taken, and what takes them', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    const why = group(view()!, 'not-assigned').querySelector('[data-intake-group-why]')!;
    expect(why.textContent).toBe('Intake takes a labelled issue only when it is assigned to you. Nothing works on these issues until you assign them to you.');
  });

  it('with issues of one repository there is no repository filter', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    expect(view()!.querySelector('[data-intake-repo-filter]')).toBeNull();
  });

  it('with issues of two repositories, the filter shows one repository\'s issues, and Assign all assigns only those', async () => {
    await boot('#intake');
    await vi.waitFor(() => expect(view()).not.toBeNull());
    await act(async () => { streamed.get('source.updated')!({ data: JSON.stringify(TWO_REPOS[0]) }); });
    const filter = view()!.querySelector<HTMLElement>('[data-intake-repo-filter]')!;
    expect([...filter.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['All repositories 8', 'hopper 6', 'tempest 2']);
    expect(row(view()!, url(3))).not.toBeNull();
    await click(button(filter, 'tempest 2'));
    expect(row(view()!, url(3))).toBeNull();
    expect(row(view()!, url(21, 'octo-user/tempest'))).not.toBeNull();
    expect(group(view()!, 'not-assigned').querySelector('[data-intake-group-count]')!.textContent).toBe('2');
    expect(view()!.querySelector('[data-intake-group="request"]')).toBeNull();
    await click(button(view()!, 'Assign all 2 to me'));
    await vi.waitFor(() => expect(posts.at(-1)).toEqual({ path: '/ui/api/sources/github-account/intake', body: { kind: 'assign', keys: [url(21, 'octo-user/tempest'), url(22, 'octo-user/tempest')] } }));
    await click(button(filter, 'All repositories 8'));
    expect(row(view()!, url(3))).not.toBeNull();
  });
});
