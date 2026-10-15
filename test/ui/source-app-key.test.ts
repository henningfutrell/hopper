// @vitest-environment happy-dom
// The GitHub App source's setup card in Sources (issue #1243): with no private key kept, it takes the key in a write-only
// field and posts it once to the vault; the field is cleared and nothing shows the key again.
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { boot, source, unmount } from './sources-daemon.ts';

afterEach(unmount);

describe('Sources view: the GitHub App private key', () => {
  it('a GitHub App source with no private key: the card takes the key in a write-only field and saves it to the vault (#1243)', async () => {
    const setupProblem = { missing: ['private key'], reason: 'private key not set', help: 'github-app-setup' };
    await boot({
      '/api/sources': { sources: [{ ...source('github-app', 'github-app', 'needs-setup', { mode: 'app' }), setupProblem }] },
      '/ui/api/github-app-key': { set: true, setAt: '2026-10-15T00:00:00.000Z', setBy: 'octo-user' },
    });
    const field = () => document.querySelector('[data-setup-problem="github-app"] [data-app-key-field]') as HTMLTextAreaElement | null;
    await vi.waitFor(() => expect(field()).not.toBeNull());
    expect(field()!.getAttribute('autocomplete')).toBe('off');
    expect(field()!.getAttribute('spellcheck')).toBe('false');
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      set.call(field(), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
      field()!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...document.querySelectorAll('[data-setup-problem="github-app"] button')].find((b) => b.textContent === 'Save the key') as HTMLButtonElement;
    await act(async () => { save.click(); });
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls.filter(([u, i]) => String(u) === '/ui/api/github-app-key' && i?.method === 'POST');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({ action: 'set', value: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----' });
    await vi.waitFor(() => expect(document.querySelector('[data-app-key-saved]')?.textContent).toContain('Saved in the vault'));
    expect(field()?.value ?? '').toBe('');
  });
});
