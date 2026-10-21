// Issue #1380, part 9 (owner decision 1: identity is keyed by the verified email throughout): a person is named in
// OpenFGA by the email their user is known by, never by the user id (a slug of a username). Real Access over a real
// instance store, OpenFGA as a double that evaluates the default model.
//
// Feature: OpenFGA subjects are keyed by email
//   Scenario: the tuples pushed name a user by its email; a user with no email yet keeps its id
//   Scenario: a check asks OpenFGA as the user's email, the owner told by email too
//   Scenario: a user who takes an email has its tuples moved to the email at the next ask
//   Scenario: a decision's path and reason name the user's email
//   Scenario: an email OpenFGA cannot take in an id is escaped
import { afterEach, describe, expect, it } from 'vitest';
import { createAccess } from '../../src/authz/service.ts';
import { emailSubject, keyedByEmail } from '../../src/authz/objects.ts';
import { openInstanceStore, type InstanceStore } from '../../src/store/index.ts';
import { createFakeAuthorizationServer } from '../support/fake-authorization-server.ts';
import { testDatabaseUrl } from '../support/database.ts';

const clock = { now: () => new Date('2026-10-15T12:00:00Z') };
const stores: InstanceStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });

function accessOf(emails: Map<string, string>) {
  const instance = openInstanceStore({ url: testDatabaseUrl(), clock });
  stores.push(instance);
  const fga = createFakeAuthorizationServer();
  const access = createAccess({
    repo: instance.access, server: fga, clock, logger: { warn: () => undefined },
    jobStatus: () => 'running',
    requesters: () => [
      { userId: 'ada', jobs: [{ jobId: 'j1', machine: 'kbox' }], boxes: [{ machine: 'kbox', template: 'kube' }] },
      { userId: 'bob', jobs: [{ jobId: 'j2' }], boxes: [] },
    ],
    emails: () => emails,
  });
  const tuples = () => [...fga.stores.values()].flatMap((s) => [...s.tuples.values()]);
  return { access, fga, tuples };
}

const PROD = { operation: 'read', asset: { kind: 'cluster', name: 'prod' } } as const;

describe('OpenFGA subjects keyed by email (issue #1380)', () => {
  it('the tuples pushed name a user by its email; a user with no email yet keeps its id', async () => {
    const { access, tuples } = accessOf(new Map([['ada', 'ada@example.com']]));
    await access.sync();
    const owners = tuples().filter((t) => t.relation === 'owns').map((t) => `${t.subject} ${t.object}`).sort();
    expect(owners).toEqual(['user:ada@example.com job:ada/j1', 'user:bob job:bob/j2']);
    expect(tuples().some((t) => t.subject === 'user:ada')).toBe(false);
  });

  it('a check asks OpenFGA as the user\'s email, the owner told by email too', async () => {
    const { access, fga } = accessOf(new Map([['ada', 'ada@example.com']]));
    const d = await access.decideSystemSecret({ requester: { kind: 'user', userId: 'ada' }, owner: 'ada', name: 'typesafe-api-key', action: 'read' });
    expect(d).toMatchObject({ allowed: true });
    expect(d.reason).toMatch(/^user:ada@example\.com may read/);
    const asked = fga.checks.at(-1)!;
    expect(asked.tuple.subject).toBe('user:ada@example.com');
    expect(asked.contextual).toContainEqual(expect.objectContaining({ subject: 'user:ada@example.com', relation: 'owner' }));
    // Another user is not the owner, by email or by id.
    expect(await access.decideSystemSecret({ requester: { kind: 'user', userId: 'bob' }, owner: 'ada', name: 'typesafe-api-key', action: 'read' })).toMatchObject({ allowed: false });
    expect(fga.checks.at(-1)!.tuple.subject).toBe('user:bob');
  });

  it('a user who takes an email has its tuples moved to the email at the next ask', async () => {
    const emails = new Map<string, string>();
    const { access, tuples } = accessOf(emails);
    await access.approve('kube', PROD, 'admin@example.com');
    expect(tuples().filter((t) => t.relation === 'owns').map((t) => t.subject).sort()).toEqual(['user:ada', 'user:bob']);
    emails.set('ada', 'ada@example.com');
    expect(await access.decideMint({ requester: { kind: 'user', userId: 'ada' }, ...PROD })).toMatchObject({ allowed: true });
    expect(tuples().filter((t) => t.relation === 'owns').map((t) => t.subject).sort()).toEqual(['user:ada@example.com', 'user:bob']);
  });

  it('a decision\'s path and reason name the user\'s email', async () => {
    const { access } = accessOf(new Map([['ada', 'ada@example.com'], ['bob', 'bob@example.com']]));
    await access.approve('kube', PROD, 'admin@example.com');
    const allowed = await access.decideMint({ requester: { kind: 'user', userId: 'ada' }, ...PROD });
    expect(allowed).toMatchObject({ allowed: true });
    expect(allowed.path?.[0]).toMatchObject({ subject: 'user:ada@example.com', relation: 'owns', object: 'job:ada/j1' });
    const denied = await access.decideMint({ requester: { kind: 'user', userId: 'bob' }, ...PROD });
    expect(denied).toMatchObject({ allowed: false });
    expect(denied.reason).toBe('user bob@example.com is not approved to read on cluster prod');
    // Users & access → Access's matrix reads the same.
    const row = access.view().requesters.find((r) => r.requester.kind === 'user' && r.requester.userId === 'ada')!;
    expect(row.grants[0]?.path[0]?.subject).toBe('user:ada@example.com');
  });

  it('an email OpenFGA cannot take in an id is escaped', () => {
    expect(emailSubject('ada@example.com')).toBe('user:ada@example.com');
    expect(emailSubject('a#b:c d%e@example.com')).toBe('user:a%23b%3Ac%20d%25e@example.com');
    const key = keyedByEmail(new Map([['ada', 'ada@example.com']]));
    expect(key({ subject: 'user:ada', relation: 'owner', object: 'artifact:ada/a1' })).toEqual({ subject: 'user:ada@example.com', relation: 'owner', object: 'artifact:ada/a1' });
    for (const subject of ['user:*', 'user:bob', 'job:ada/j1', 'link:ada/s1']) expect(key({ subject, relation: 'r', object: 'o:x' }).subject).toBe(subject);
  });
});
