// The trusted actor picker (issue #930, design.md "Trusted origin and request cards"): the accounts it offers — the
// connected account, the job repositories' collaborators, their organizations' members, the authors of their newest
// issues, and the hopper's own users and API token holders by their connected GitHub —, and the check of the ids a
// person saves: each one an account GitHub knows, and a person's, never an app's, a bot's or an organization's.
import { CANDIDATE_FROM, type ActorCandidate, type ActorCandidates, type CandidateFrom, type GitHubAccount } from '../domain/intake-origin.ts';
import type { ActorsGitHub } from './github.ts';

/** At most this many job repositories are read for candidates. */
export const CANDIDATE_REPOS = 20;

/** A refusal, with the HTTP status it is. */
export class IntakeActorsRefused extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'IntakeActorsRefused';
    this.status = status;
  }
}

/** Only a person's account starts jobs: an app's, a bot's or an organization's never does. */
export const isPerson = (a: GitHubAccount): boolean => a.type === 'User';

export async function actorCandidates(o: {
  github: ActorsGitHub;
  /** The job repositories, owner/name. */
  repos: readonly string[];
  /** The connected account's login. */
  connected: string;
  /** Each user of the hopper with a connected GitHub: its login, and whether the user holds a live API token. */
  hopperUsers: readonly { login: string; apiToken: boolean }[];
}): Promise<ActorCandidates> {
  const found = new Map<number, ActorCandidate>();
  const problems: string[] = [];
  const add = (from: CandidateFrom, list: readonly (GitHubAccount | undefined)[]) => {
    for (const a of list) {
      if (!a || !isPerson(a)) continue;
      const c = found.get(a.id) ?? { ...a, from: [] };
      if (!c.from.includes(from)) c.from.push(from);
      found.set(a.id, c);
    }
  };
  const read = async <T>(what: string, p: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await p();
    } catch (err) {
      problems.push(`${what}: ${(err as Error).message}`);
      return undefined;
    }
  };
  const repos = o.repos.slice(0, CANDIDATE_REPOS);
  add('connected', [await read('the connected account', () => o.github.byLogin(o.connected))]);
  for (const repo of repos) add('collaborator', (await read(`the collaborators of ${repo}`, () => o.github.collaborators(repo))) ?? []);
  for (const org of [...new Set(repos.map((r) => r.split('/')[0]!))]) add('member', (await read(`the members of ${org}`, () => o.github.members(org))) ?? []);
  for (const repo of repos) add('author', (await read(`the issue authors of ${repo}`, () => o.github.recentAuthors(repo))) ?? []);
  for (const u of o.hopperUsers) {
    const a = await read(`the hopper user ${u.login}`, () => o.github.byLogin(u.login));
    add('hopper-user', [a]);
    if (u.apiToken) add('api-token', [a]);
  }
  const candidates = [...found.values()]
    .map((c) => ({ ...c, from: CANDIDATE_FROM.filter((f) => c.from.includes(f)) }))
    .sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
  return { candidates, problems };
}

/** The accounts of these ids, each read from GitHub: one GitHub does not know, or not a person's, is refused. Sorted by login. */
export async function resolveActors(github: ActorsGitHub, ids: readonly number[]): Promise<GitHubAccount[]> {
  const out: GitHubAccount[] = [];
  for (const id of new Set(ids)) {
    const a = await github.byId(id);
    if (!a) throw new IntakeActorsRefused(400, `GitHub knows no account with id ${id}`);
    if (!isPerson(a)) throw new IntakeActorsRefused(400, `${a.login} is a ${a.type}, not a person: an app, a bot or an organization is never a trusted actor`);
    out.push(a);
  }
  return out.sort((a, b) => a.login.toLowerCase().localeCompare(b.login.toLowerCase()));
}
