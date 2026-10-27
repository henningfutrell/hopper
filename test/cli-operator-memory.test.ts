// `hopper memory` (issue #2847, src/cli-operator-memory.ts): each verb is the UI call it makes, and a bad line is the usage.
import { describe, expect, it } from 'vitest';
import { memoryCall } from '../src/cli-operator-memory.ts';

const none = async () => undefined;

describe('hopper memory (issue #2847)', () => {
  it('list reads the entries, of one repository with --repo', () => {
    expect(memoryCall(['list'])).toMatchObject({ role: 'viewer', path: '/api/repo-memory' });
    expect(memoryCall(['list', '--repo', 'acme/app'])).toMatchObject({ role: 'viewer', path: '/api/repo-memory?repo=acme%2Fapp' });
  });

  it('add posts the entry; --area may be left out', async () => {
    const c = memoryCall(['add', '--repo', 'acme/app', '--kind', 'fix', '--area', 'src/store', '--text', 'A migration is appended.']);
    expect(c).toMatchObject({ role: 'admin', path: '/ui/api/repo-memory' });
    expect(await c.body!(none)).toEqual({ action: 'add', repo: 'acme/app', kind: 'fix', area: 'src/store', text: 'A migration is appended.' });
    expect(await memoryCall(['add', '--repo', 'acme/app', '--kind', 'fix', '--text', 't']).body!(none)).not.toHaveProperty('area');
  });

  it('edit posts what changes; --no-area takes the area away', async () => {
    expect(await memoryCall(['edit', '1a2b3c4d', '--text', 'new']).body!(none)).toEqual({ action: 'edit', id: '1a2b3c4d', text: 'new' });
    expect(await memoryCall(['edit', '1a2b3c4d', '--no-area', '--kind', 'convention']).body!(none)).toEqual({ action: 'edit', id: '1a2b3c4d', kind: 'convention', area: null });
  });

  it('approve, disable, enable and remove post their action', async () => {
    for (const action of ['approve', 'disable', 'enable', 'remove']) expect(await memoryCall([action, 'x']).body!(none)).toEqual({ action, id: 'x' });
  });

  it.each([[['add', '--repo', 'a/b']], [['edit', 'x']], [['edit', 'x', '--area', 'a', '--no-area']], [['approve']], [['remove', 'x', '--text', 't']], [['list', 'x']], [['frob', 'x']]])('%j is the usage', (args) => {
    expect(() => memoryCall(args)).toThrow(/^usage: hopper memory/);
  });
});
