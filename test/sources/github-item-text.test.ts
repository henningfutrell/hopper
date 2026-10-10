// A GitHub item rendered with another text (issue #662): the job of a later run gets its snapshot's title, body and
// comments in place of the live ones, the rest of the context block as read now. Rendered with the text it was read
// with, it is the item as it was.
import { describe, expect, it } from 'vitest';
import { contextBlock, issueEnv, issuePrompt, promptWithText } from '../../src/sources/github/context.ts';

const issue = { repo: 'o/r', number: 7, url: 'https://github.com/o/r/issues/7', title: 'Live title', body: 'Live body.', author: 'owner', assignees: ['owner'], labels: ['hopper'], state: 'open' as const, updatedAt: '' };
const live = [{ id: 1, author: 'owner', body: 'A live note.', createdAt: '2026-10-01T10:00:00Z', url: '' }];
const p = { priority: 75, reason: 'label:hopper:high', projectItem: 'none' };
const item = { title: issue.title, body: issue.body, prompt: issuePrompt(issue, contextBlock(issue, p, true, live, 10)), env: issueEnv(issue) };

describe('a GitHub item rendered with a text (issue #662)', () => {
  it('with the text it was read with, is the item as it was', () => {
    const same = promptWithText(item, { title: issue.title, body: issue.body, comments: [{ author: 'owner', at: '2026-10-01T10:00:00Z', body: 'A live note.' }] }, 10, 'account');
    expect(same).toEqual(item);
  });

  it('with the snapshot\'s text, carries its title, body and comments, and the context as read now', () => {
    const r = promptWithText(item, { title: 'Approved title', body: 'Approved body.', comments: [] }, 10, 'account');
    expect(r.title).toBe('Approved title');
    expect(r.body).toBe('Approved body.');
    expect(r.env.HOPPER_ISSUE_TITLE).toBe('Approved title');
    expect(r.prompt.startsWith('Approved body.\n\n[hopper issue context]')).toBe(true);
    expect(r.prompt).toContain('\ntitle: Approved title\n');
    expect(r.prompt).toContain('priority: 75 (label:hopper:high)');
    expect(r.prompt).toContain('Yolo mode is on');
    expect(r.prompt).toContain('recent comments: none');
    expect(r.prompt).not.toContain('Live');
  });

  it('refuses an item whose prompt is not its body and context block', () => {
    expect(() => promptWithText({ ...item, prompt: 'something else' }, { title: 't', body: 'b', comments: [] }, 10, 'account')).toThrow(/cannot be rendered/);
  });
});
