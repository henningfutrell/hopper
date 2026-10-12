// The trusted actors in force (issue #930): kept by GitHub user id, so a rename keeps the trust and a login another
// account takes later gets none. A list kept before ids, by login, still counts by login; none named: the connected login.
import { describe, expect, it } from 'vitest';
import { toldFor, trustedActors } from '../../src/domain/intake-origin.ts';

const teammate = { id: 42, login: 'Teammate', type: 'User' };
const owner = { id: 1, login: 'owner', type: 'User' };

describe('trusted actors (issue #930)', () => {
  it('the accounts named, by id and lowercased login', () => {
    expect(trustedActors({ actors: ['teammate', 'owner'], accounts: [teammate, owner] }, { login: 'owner', id: 1 }))
      .toEqual([{ login: 'owner', id: 1 }, { login: 'teammate', id: 42 }]);
  });

  it('none named: the connected login, with its id when known', () => {
    expect(trustedActors(undefined, { login: 'Owner', id: 1 })).toEqual([{ login: 'owner', id: 1 }]);
    expect(trustedActors({ actors: [] }, { login: 'owner' })).toEqual([{ login: 'owner' }]);
  });

  it('a list kept before ids: its logins, with no id', () => {
    expect(trustedActors({ actors: ['teammate'] }, { login: 'owner' })).toEqual([{ login: 'teammate' }]);
  });

  it('Access is told the login an account has now: a renamed account stays trusted', () => {
    const actors = trustedActors({ actors: ['teammate'], accounts: [teammate] }, { login: 'owner' });
    expect(toldFor(actors, { login: 'new-name', id: 42 })).toEqual(['new-name']);
  });

  it('a login another account has now is not told: its old trust does not pass to the new account', () => {
    const actors = trustedActors({ actors: ['teammate'], accounts: [teammate] }, { login: 'owner' });
    expect(toldFor(actors, { login: 'teammate', id: 7 })).toEqual([]);
  });

  it('an act whose id GitHub did not give is matched by login', () => {
    const actors = trustedActors({ actors: ['teammate'], accounts: [teammate] }, { login: 'owner' });
    expect(toldFor(actors, { login: 'teammate' })).toEqual(['teammate']);
  });

  it('an actor kept by login only is told by login', () => {
    const actors = trustedActors({ actors: ['teammate'] }, { login: 'owner' });
    expect(toldFor(actors, { login: 'Teammate', id: 42 })).toEqual(['teammate']);
  });
});
