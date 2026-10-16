// Audit and attribution keyed by email (issue #1380): a person is recorded by the verified email their user is known by,
// else by the name the realm gave; text that goes to GitHub or to a job names them without an email address. Pure.
import { describe, expect, it } from 'vitest';
import { nameWithoutEmail } from '../../src/domain/users.ts';
import { actingOf, personOf } from '../../src/http/ui/sessions.ts';

const ada = { realm: 'corp', subject: 'sub-ada', name: 'Ada Lovelace', username: 'ada', email: 'ada@corp.example', groups: [] };

describe('who is recorded for an act (issue #1380)', () => {
  it('is the email of the session\'s user, else the name the realm gave', () => {
    expect(personOf({ identity: ada, email: 'ada@example.com' })).toBe('ada@example.com');
    expect(personOf({ identity: ada })).toBe('Ada Lovelace');
    expect(actingOf({ identity: ada, email: 'ada@example.com', kind: 'ui' })).toEqual({ person: 'ada@example.com', via: 'ui' });
    expect(actingOf({ identity: ada, email: 'ada@example.com', kind: 'api' })).toEqual({ person: 'ada@example.com', via: 'api' });
  });

  it('is named without an email address where the text leaves the hopper', () => {
    expect(nameWithoutEmail('ada@example.com')).toBe('ada');
    expect(nameWithoutEmail('Ada Lovelace')).toBe('Ada Lovelace');
    expect(nameWithoutEmail('ops (delegate of ada@example.com)')).toBe('ops (delegate of ada)');
  });
});
