// The access model's objects and tuples (issues #559, #581), pure: how a requester, a template, an operation profile
// and an asset are named in OpenFGA, the two tuples an approval is, the tuples of who is live, and the relationship path
// that explains an allow.
import { createHash } from 'node:crypto';
import {
  OPERATIONS, ASSET_KINDS, type ApiTokenAsk, type ApiTokenBoxAsk, type LiveRequesters, type RelayAsk, type SharedSecretAsk, type SystemSecretAsk, type Operation, type OperationProfile, type RelationshipTuple, type Requester, type Asset, type AssetKind,
} from '../domain/types.ts';

export const templateObject = (template: string): string => `template:${template}`;
export const userObject = (userId: string): string => `user:${userId}`;
/** A person by the verified email their user is known by (issue #1380): OpenFGA takes no space, `:` or `#` in an id, so each is escaped, and `%` too, so two emails never meet. */
export const emailSubject = (email: string): string => `user:${email.replace(/[\s:#%]/g, (c) => encodeURIComponent(c))}`;
/**
 * Tuples as OpenFGA is given them (issue #1380, owner decision 1: identity keyed by email): each `user:<id>` names the
 * email the user is known by. A user with no email yet keeps its id, which holds no `@`, so it never names an email.
 */
export function keyedByEmail(emails: ReadonlyMap<string, string>): (t: RelationshipTuple) => RelationshipTuple {
  const key = (s: string): string => {
    const email = s.startsWith('user:') ? emails.get(s.slice('user:'.length)) : undefined;
    return email === undefined ? s : emailSubject(email);
  };
  return (t) => ({ subject: key(t.subject), relation: t.relation, object: key(t.object) });
}
export const jobObject = (job: { userId: string; jobId: string }): string => `job:${job.userId}/${job.jobId}`;
/** OpenFGA takes no space, `:` or `#` in an id, and a machine's name may hold one: it is escaped. */
export const machineObject = (m: { userId: string; machine: string }): string => `machine:${m.userId}/${encodeURIComponent(m.machine)}`;

export function requesterObject(r: Requester): string {
  if (r.kind === 'job') return jobObject(r);
  if (r.kind === 'machine') return machineObject(r);
  return userObject(r.userId);
}

/** Who is live, as tuples: a user owns each live job, a job runs on its machine, a box is an instance of its template. */
export function requesterTuples(live: readonly LiveRequesters[]): RelationshipTuple[] {
  return live.flatMap(({ userId, jobs, boxes }) => [
    ...jobs.flatMap(({ jobId, machine }) => {
      const job = jobObject({ userId, jobId });
      return [
        { subject: userObject(userId), relation: 'owns', object: job },
        ...(machine === undefined ? [] : [{ subject: job, relation: 'runs_on', object: machineObject({ userId, machine }) }]),
      ];
    }),
    ...boxes.map(({ machine, template }) => ({ subject: machineObject({ userId, machine }), relation: 'instance_of', object: templateObject(template) })),
  ]);
}
/** An artifact (issue #624), a public link to one, and the tuple each live share is: its user or link is a viewer. */
export const artifactObject = (a: { userId: string; id: string }): string => `artifact:${a.userId}/${a.id}`;
/** A source item (issue #662), by its owner and the SHA-256 of its key: a key is a URL, which an object id cannot carry. */
export const itemObject = (i: { ownerId: string; key: string }): string => `item:${i.ownerId}/${createHash('sha256').update(i.key).digest('hex')}`;
/** The vault grant of a user's item (issue #652): its key hashed, as an item's. */
export const vaultGrantObject = (g: { ownerId: string; key: string }): string => `vault_grant:${g.ownerId}/${createHash('sha256').update(g.key).digest('hex')}`;
/** A job's terminal (issue #1128): the user whose job it is, and the job. */
export const terminalObject = (t: { ownerId: string; jobId: string }): string => `terminal:${t.ownerId}/${encodeURIComponent(t.jobId)}`;
/** The check whether a user may attach to a job's terminal (issue #1128): the job's owner, told for this check only. */
export function terminalCheck(userId: string, t: { ownerId: string; jobId: string }): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = terminalObject(t);
  return { tuple: { subject: userObject(userId), relation: 'can_attach', object }, contextual: [{ subject: userObject(t.ownerId), relation: 'owner', object }] };
}
/** A machine's terminal (issue #1128): the user whose machine it is, and the machine. */
export const machineTerminalObject = (t: { ownerId: string; machineId: string }): string => `machine_terminal:${t.ownerId}/${encodeURIComponent(t.machineId)}`;
/** The check whether a user may attach to a machine's terminal (issue #1128): the machine's owner, told for this check only. */
export function machineTerminalCheck(userId: string, t: { ownerId: string; machineId: string }): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = machineTerminalObject(t);
  return { tuple: { subject: userObject(userId), relation: 'can_attach', object }, contextual: [{ subject: userObject(t.ownerId), relation: 'owner', object }] };
}
/** A target of a user's bastions (issue #2146): OpenFGA takes no `:` in an id, and a target holds one, so it is escaped. */
export const bastionObject = (b: { userId: string; target: string }): string => `bastion:${b.userId}/${encodeURIComponent(b.target)}`;
/**
 * The check whether a job may relay to a target of its bastion (issue #2146): the job as its owner and as running its
 * template, and the template as approved for the target only when a person approved it, told for this check only.
 */
export function relayCheck(a: RelayAsk): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = bastionObject(a), job = jobObject(a);
  return {
    tuple: { subject: job, relation: 'can_relay', object },
    contextual: [
      { subject: job, relation: 'owner', object }, { subject: job, relation: 'running', object: templateObject(a.template) },
      ...(a.approved ? [{ subject: templateObject(a.template), relation: 'approved_for', object }] : []),
    ],
  };
}
/** A search hit (issue #945): the user whose work it is, its type and its id there. */
export const searchHitObject = (h: { ownerId: string; type: string; ref: string }): string => `search_hit:${h.ownerId}/${h.type}/${encodeURIComponent(h.ref)}`;
/** The check whether a user may see a search hit (issue #945): its owner, and every user unless it is private, told for this check only. */
export function searchHitCheck(viewerId: string, hit: { ownerId: string; type: string; ref: string; private: boolean }): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = searchHitObject(hit);
  return {
    tuple: { subject: userObject(viewerId), relation: 'can_view', object },
    contextual: [
      { subject: userObject(hit.ownerId), relation: 'owner', object },
      ...(hit.private ? [] : [{ subject: 'user:*', relation: 'reader', object }]),
    ],
  };
}
/** A GitHub login (issue #652), lowercased: GitHub logins compare without case. */
export const githubLoginObject = (login: string): string => `github_login:${encodeURIComponent(login.toLowerCase())}`;
/** A user's intake (issue #652). */
export const intakeObject = (userId: string): string => `intake:${userId}`;
/** The check whether `login` may start the user's jobs (issue #652): the user's trusted actors told for this check only. */
export function intakeActorCheck(userId: string, login: string, actors: readonly string[]): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = intakeObject(userId);
  return {
    tuple: { subject: githubLoginObject(login), relation: 'can_start_jobs', object },
    contextual: [...new Set(actors.map((a) => githubLoginObject(a)))].map((subject) => ({ subject, relation: 'trusted_actor', object })),
  };
}
/** A GitLab user (issue #1448): `gitlab_account:<the GitLab's URL>/<user id>`, the URL encoded; a rename keeps the id. */
export const gitlabAccountObject = (a: { baseUrl: string; userId: number }): string => `gitlab_account:${encodeURIComponent(a.baseUrl)}/${a.userId}`;
/** The check whether a GitLab user may start the user's jobs (issue #1448): the user's trusted GitLab actors told for this check only. */
export function gitlabIntakeActorCheck(userId: string, actor: { baseUrl: string; userId: number }, actors: readonly { baseUrl: string; userId: number }[]): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = intakeObject(userId);
  return {
    tuple: { subject: gitlabAccountObject(actor), relation: 'can_start_jobs', object },
    contextual: [...new Set(actors.map(gitlabAccountObject))].map((subject) => ({ subject, relation: 'trusted_actor', object })),
  };
}
export const linkObject = (l: { userId: string; shareId: string }): string => `link:${l.userId}/${l.shareId}`;
export function shareTuples(shares: readonly { ownerId: string; artifactId: string; shareId: string; userId?: string }[]): RelationshipTuple[] {
  return shares.map((s) => ({
    subject: s.userId !== undefined ? userObject(s.userId) : linkObject({ userId: s.ownerId, shareId: s.shareId }),
    relation: 'viewer', object: artifactObject({ userId: s.ownerId, id: s.artifactId }),
  }));
}
/** A system secret of a user (issue #657): `system_secret:<user>/<name>`. */
export const systemSecretObject = (s: { userId: string; name: string }): string => `system_secret:${s.userId}/${s.name}`;

/**
 * The check for an ask about a system secret (issue #657): `can_change` or `can_read` of the requester. Who the secret is
 * kept for, and an admin's session, are told for this check only, as contextual tuples: no stored tuple says either.
 */
export function systemSecretCheck(ask: SystemSecretAsk): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = systemSecretObject({ userId: ask.owner, name: ask.name });
  const subject = requesterObject(ask.requester);
  return {
    tuple: { subject, relation: `can_${ask.action}`, object },
    contextual: [
      { subject: userObject(ask.owner), relation: 'owner', object },
      ...(ask.admin && ask.requester.kind === 'user' ? [{ subject, relation: 'admin', object }] : []),
    ],
  };
}
/** A shared secret (issue #718): `shared_secret:<name>`, one for the whole hopper. */
export const sharedSecretObject = (name: string): string => `shared_secret:${name}`;

/**
 * The check for an ask about a shared secret (issue #718): `can_read` or `can_change` of the user. Its readers — every
 * user, as the wildcard, when none are named — and an admin's session are told for this check only.
 */
export function sharedSecretCheck(ask: SharedSecretAsk): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = sharedSecretObject(ask.name);
  const subject = userObject(ask.userId);
  const readers = ask.readers ? ask.readers.map(userObject) : ['user:*'];
  return {
    tuple: { subject, relation: `can_${ask.action}`, object },
    contextual: [
      ...readers.map((r) => ({ subject: r, relation: 'reader', object })),
      ...(ask.admin ? [{ subject, relation: 'admin', object }] : []),
    ],
  };
}
/** The relation an API token's use asks for each role (issue #718). */
export const API_TOKEN_RELATIONS = { viewer: 'can_view', operator: 'can_operate', admin: 'can_administer' } as const;

/** The check for a use of an API token (issue #718): the relation of its role, of the user; the user told as its owner. */
export function apiTokenCheck(ask: ApiTokenAsk): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = `api_token:${ask.userId}/${ask.tokenId}`;
  const subject = userObject(ask.userId);
  return { tuple: { subject, relation: API_TOKEN_RELATIONS[ask.role], object }, contextual: [{ subject, relation: 'owner', object }] };
}

/** The check for a box action with an API token (issue #795): `can_run_on_box`, the owner told, and `box_runner` for a box token only. */
export function apiTokenBoxCheck(ask: ApiTokenBoxAsk): { tuple: RelationshipTuple; contextual: RelationshipTuple[] } {
  const object = `api_token:${ask.userId}/${ask.tokenId}`;
  const subject = userObject(ask.userId);
  return {
    tuple: { subject, relation: 'can_run_on_box', object },
    contextual: [{ subject, relation: 'owner', object }, ...(ask.box ? [{ subject, relation: 'box_runner', object }] : [])],
  };
}
export const assetObject = (t: Asset): string => `asset:${t.kind}/${t.name}`;

/** `read/cluster/x`: the operation, then the asset. */
export const profileId = (p: OperationProfile): string => `${p.operation}/${p.asset.kind}/${p.asset.name}`;
export const profileObject = (p: OperationProfile): string => `operation_profile:${profileId(p)}`;

/** The operation profile an id names, or undefined. */
export function profileOf(id: string): OperationProfile | undefined {
  const first = id.indexOf('/');
  const second = id.indexOf('/', first + 1);
  if (first < 0 || second < 0) return undefined;
  const operation = id.slice(0, first);
  const kind = id.slice(first + 1, second);
  const name = id.slice(second + 1);
  if (!(OPERATIONS as readonly string[]).includes(operation) || !(ASSET_KINDS as readonly string[]).includes(kind) || name === '') return undefined;
  return { operation: operation as Operation, asset: { kind: kind as AssetKind, name } };
}

/** The profile grants its operation on its asset; the template is approved for the profile. */
export function approvalTuples(template: string, p: OperationProfile): { grant: RelationshipTuple; approval: RelationshipTuple } {
  const profile = profileObject(p);
  return {
    grant: { subject: profile, relation: `grants_${p.operation}`, object: assetObject(p.asset) },
    approval: { subject: templateObject(template), relation: 'approved_for', object: profile },
  };
}

/** The tuple a check tried in Users & access → Access adds for its made-up job: the job is running from the template. */
export const runningTuple = (job: string, template: string): RelationshipTuple => ({ subject: job, relation: 'running', object: templateObject(template) });

const same = (a: RelationshipTuple, b: RelationshipTuple) => a.subject === b.subject && a.relation === b.relation && a.object === b.object;
/** The steps from a requester to its template, as the default model reads them. */
const TOWARD_TEMPLATE = new Set(['owns', 'runs_on', 'instance_of', 'running']);

/**
 * The path from the requester (a job's owner first) to the asset through the tuples given — who is live, and the approval rows —, when they
 * hold one; undefined when they do not (a model edit allowed it another way): the path is the hopper's reading of its
 * own rows, not OpenFGA's.
 */
export function relationshipPath(live: readonly RelationshipTuple[], requester: string, p: OperationProfile): RelationshipTuple[] | undefined {
  const walk = (at: string, seen: Set<string>): RelationshipTuple[] | undefined => {
    if (at.startsWith('template:')) {
      const { grant, approval } = approvalTuples(at.slice('template:'.length), p);
      return live.some((t) => same(t, grant)) && live.some((t) => same(t, approval)) ? [approval, grant] : undefined;
    }
    for (const step of live) {
      if (step.subject !== at || !TOWARD_TEMPLATE.has(step.relation) || seen.has(step.object)) continue;
      const rest = walk(step.object, new Set([...seen, step.object]));
      if (rest) return [step, ...rest];
    }
    return undefined;
  };
  const path = walk(requester, new Set([requester]));
  // A job's path names whose job it is too: its owner, when the hopper wrote one.
  const owner = requester.startsWith('job:') ? live.find((t) => t.relation === 'owns' && t.object === requester) : undefined;
  return path && owner ? [owner, ...path] : path;
}
