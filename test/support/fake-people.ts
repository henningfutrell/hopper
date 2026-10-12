// The fake GitHub's accounts (issue #930), for test/support/fake-forges.ts: who exists, by login and by id, a
// repository's collaborators, an organization's members, and the authors of a repository's newest issues. A login not
// named in `people` does not exist; a bot is one with `type: 'Bot'`.

/** One account GitHub knows. */
export interface FakePerson { id: number; type?: string }

export interface PeopleForge {
  /** The accounts by login. */
  people?: Record<string, FakePerson>;
  /** A repository's collaborators, by owner/name; a repository not named answers 403 (the connection is no collaborator). */
  collaborators?: Record<string, string[]>;
  /** An organization's members, by its login; an account not named is no organization (404). */
  orgMembers?: Record<string, string[]>;
}

type Answer = { status: number; body?: unknown };

const notFound: Answer = { status: 404, body: { message: 'Not Found' } };

export function personOf(forge: PeopleForge | undefined, base: string, login: string): Record<string, unknown> | undefined {
  const p = forge?.people?.[login];
  return p ? { login, id: p.id, type: p.type ?? 'User', avatar_url: `${base}/avatars/u/${p.id}` } : undefined;
}

/** The answer to an account read, or undefined when the request is no such read. `issues`: each issue's repo and author. */
export function peopleRoute(forge: PeopleForge | undefined, base: string, issues: { repo: string; author: string }[], method: string, path: string, query: Record<string, string>): Answer | undefined {
  if (method !== 'GET' || !forge?.people) return undefined;
  const person = (login: string) => personOf(forge, base, login);
  const byId = /^\/user\/(\d+)$/.exec(path);
  if (byId) {
    const login = Object.entries(forge.people).find(([, p]) => p.id === Number(byId[1]))?.[0];
    return login ? { status: 200, body: person(login) } : notFound;
  }
  const byLogin = /^\/users\/([^/]+)$/.exec(path);
  if (byLogin) {
    const login = Object.keys(forge.people).find((l) => l.toLowerCase() === decodeURIComponent(byLogin[1]!).toLowerCase());
    return login ? { status: 200, body: person(login) } : notFound;
  }
  const collaborators = /^\/repos\/([^/]+\/[^/]+)\/collaborators$/.exec(path);
  if (collaborators) {
    const logins = forge.collaborators?.[collaborators[1]!];
    return logins ? { status: 200, body: logins.map(person).filter(Boolean) } : { status: 403, body: { message: 'Must have push access to view repository collaborators.' } };
  }
  const members = /^\/orgs\/([^/]+)\/members$/.exec(path);
  if (members) {
    const logins = forge.orgMembers?.[members[1]!];
    return logins ? { status: 200, body: logins.map(person).filter(Boolean) } : notFound;
  }
  const repoIssues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
  if (repoIssues && query.state === 'all') {
    return { status: 200, body: issues.filter((i) => i.repo === repoIssues[1]).reverse().map((i, n) => ({ number: n + 1, user: person(i.author) ?? { login: i.author } })) };
  }
  return undefined;
}
