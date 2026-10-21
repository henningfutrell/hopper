// The access model (issues #559, #581): OpenFGA's DSL, kept in the hopper's database and edited in Users & access → Access.
// The default says a requester — a job, a machine or a user — may do an operation on an asset when it reaches a
// template approved for the operation profile that grants it: a user owns a job, the job runs on a machine, the
// machine is an instance of the template. The hopper writes those tuples from who is live, and removes them when a
// job ends or a machine leaves. An edit may change how a relation is reached, never drop one the hopper writes or
// asks (`modelGaps`).
import { transformer } from '@openfga/syntax-transformer';
import { OPERATIONS } from '../domain/types.ts';
import { TRUST_MODEL, TRUST_WRITTEN } from './trust-model.ts';

/** The operations every model decides; observe (issue #2146) came later and is apart (`observeGaps`). */
const MINT_OPERATIONS = OPERATIONS.filter((op) => op !== 'observe');

export const DEFAULT_ACCESS_MODEL = `model
  schema 1.1

# A person the hopper works for. The hopper writes that a user owns each of their live jobs.
type user

# One run of a job. Its owner, and the machine it runs on, are written while it is live and removed when it is not.
type job
  relations
    define owns: [user]

# A machine jobs run on. The hopper writes each live job that runs on it.
type machine
  relations
    define runs_on: [job]
    define owner: owns from runs_on

# A kind of machine (the vault's templates, issue #558). A box is an instance of the template it joined as, until it
# leaves. A check tried in Users & access → Access tells a made-up job running from it, for that check only.
type template
  relations
    define running: [job]
    define instance_of: [machine]
    define requester: running or instance_of or runs_on from instance_of or owner from instance_of

${TRUST_MODEL}
# What a credential is for: a cluster, a namespace, an Argo CD app, a Terraform workspace, an AWS account or role.
type asset
  relations
    define grants_read: [operation_profile]
    define grants_write: [operation_profile]
    define grants_sync: [operation_profile]
    define grants_apply: [operation_profile]
    define grants_observe: [operation_profile]
    define can_read: requester from grants_read
    define can_write: requester from grants_write
    define can_sync: requester from grants_sync
    define can_apply: requester from grants_apply
    define can_observe: requester from grants_observe

# A public link to an artifact (issue #624): anybody who holds it, while it is live.
type link

# A file a job made for a person to see (issue #624). Its owner sees it; the hopper writes each live share as a viewer.
type artifact
  relations
    define owner: [user]
    define viewer: [user, link]
    define can_view: owner or viewer

# A secret in the vault's system scope (issue #657): kept for the hopper's own use for one user, such as their TypeSafe
# API key. At each ask the hopper tells who the user is (owner) and, for an admin's session, the admin. The user or an
# admin may change it; only the user may read it, so no job, machine or template does.
type system_secret
  relations
    define owner: [user]
    define admin: [user]
    define can_change: owner or admin
    define can_read: owner

# A secret an admin shares with agents (issue #718), in the instance's vault. At each ask the hopper tells its readers —
# every user (user:*) when the admin named none — and, for the hopper's admin's session, the admin. A job reads it as
# its user; only an admin changes it.
type shared_secret
  relations
    define admin: [user]
    define reader: [user, user:*]
    define can_change: admin
    define can_read: reader

# An API token (issue #718): a short-lived token a user, or an agent acting for them, acts through the API with. At each use
# the hopper tells its owner and asks the relation of the role the request needs: a read (can_view), an operator's action
# (can_operate), or an admin's (can_administer). The role the token was minted with is checked apart; this is the user's
# own say over what their tokens may do: edit a relation to narrow it. A box action (issue #795: a route that starts a job,
# runs a command, approves or merges work, updates the hopper or a client, or changes the work on a machine) asks
# can_run_on_box too. The hopper tells its owner as box_runner only for a box token: one a person minted with box from a
# UI session. No other token has it.
type api_token
  relations
    define owner: [user]
    define can_view: owner
    define can_operate: owner
    define can_administer: owner
    define box_runner: [user]
    define can_run_on_box: box_runner and owner

# A source item jobs run (issue #662): a GitHub issue. The hopper tells, at each check, the user whose hopper takes it as its
# owner. Only who may accept new text replaces the text the item's jobs run.
type item
  relations
    define owner: [user]
    define can_accept_text: owner

# A GitHub login, lowercased (issue #652): one who wrote, labelled or assigned an issue.
type github_login

# A GitLab user (issue #1448): one who wrote, labelled, assigned or edited a GitLab issue, by the GitLab's URL and user id.
type gitlab_account

# A user's intake (issue #652): whose acts on GitHub start the user's jobs. The hopper tells, at each check, the user's
# trusted actors — the logins named in Settings → Intake, else the user's connected login; on GitLab (issue #1448), the
# user's GitLab account. An issue is a job only when its author, and whoever labelled and assigned it, may start jobs; any
# other is a request card a person approves.
type intake
  relations
    define trusted_actor: [github_login, gitlab_account]
    define can_start_jobs: trusted_actor

# A job's vault grant (issue #652): whether the jobs of one item may use the vault's helper — a vault secret or a minted
# credential — within their box's template. The hopper tells, at each check, the user whose jobs they are as its owner. A
# job asks for a grant; only who may grant gives it, a person signed in, never a job.
type vault_grant
  relations
    define owner: [user]
    define can_grant: owner

# A search hit (issue #945): a document search found, such as a job. At each search the hopper tells the user whose work it
# is as its owner and, for a hit that is not private, every user (user:*) as a reader. A direct job's hit (issue #901) is
# private: only its owner sees it.
type search_hit
  relations
    define owner: [user]
    define reader: [user, user:*]
    define can_view: owner or reader

# A job's terminal (issue #1128): a person who views a running job's herdr pane and types into it. At each use the hopper
# tells the user whose job it is as its owner. Only a person signed in attaches, through a UI session or an API token;
# a job, a machine or a box never.
type terminal
  relations
    define owner: [user]
    define can_attach: owner

# A machine's terminal (issue #1128): a person who views a pane of the hopper's herdr session on a machine and types
# into it, a pane no job holds too. At each use the hopper tells the user whose machine it is as its owner. Only a
# person signed in attaches, an admin, through a UI session or an API token; a job, a machine or a box never.
type machine_terminal
  relations
    define owner: [user]
    define can_attach: owner

# A target of a job's bastion (issue #2146): a service, a pod or a deployment and a port, in a namespace of a cluster. At
# each relay connection the hopper tells the job whose bastion it is (owner), that the job runs the bastion's template
# (template#running), and, only when a person approved the target with that template, the template (approved_for). A
# job relays to a target only when it owns the bastion and the target is approved for a template it runs.
type bastion
  relations
    define owner: [job]
    define approved_for: [template]
    define can_relay: owner and requester from approved_for
`;

interface RelationMetadata { directly_related_user_types?: { type: string }[] }
export interface ModelJson {
  schema_version: string;
  type_definitions: { type: string; relations?: Record<string, unknown>; metadata?: { relations?: Record<string, RelationMetadata> } | null }[];
}

/** The DSL as OpenFGA's JSON; throws, saying where, when it does not parse. */
export function compileAccessModel(dsl: string): ModelJson {
  return transformer.transformDSLToJSONObject(dsl) as unknown as ModelJson;
}

/** What the hopper tells and asks for API tokens (issue #718): apart, so a model edited before them still decides mints. */
const API_TOKEN_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['api_token', 'owner', 'user']];
const API_TOKEN_ASKED: readonly [type: string, relation: string][] = [['api_token', 'can_view'], ['api_token', 'can_operate'], ['api_token', 'can_administer']];
/** What the hopper tells and asks for a box action (issue #795): apart, so a model edited before it still decides the rest. */
const API_TOKEN_BOX_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['api_token', 'box_runner', 'user']];
const API_TOKEN_BOX_ASKED: readonly [type: string, relation: string][] = [['api_token', 'can_run_on_box']];

/** What the hopper tells and asks for items (issue #662): apart, so a model edited before them still decides mints. */
const ITEM_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['item', 'owner', 'user']];
const ITEM_ASKED: readonly [type: string, relation: string][] = [['item', 'can_accept_text']];

/** What the hopper tells and asks for intake (issue #652): apart, so a model edited before them still decides mints. */
const INTAKE_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['intake', 'trusted_actor', 'github_login']];
const INTAKE_ASKED: readonly [type: string, relation: string][] = [['intake', 'can_start_jobs']];
/** What the hopper tells for intake on GitLab (issue #1448): apart, so a model edited before it still decides GitHub's. */
const GITLAB_INTAKE_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['intake', 'trusted_actor', 'gitlab_account']];

/** What the hopper writes (a relation and the type it accepts) and what it asks. */
const WRITTEN: readonly [type: string, relation: string, accepts: string][] = [
  ['job', 'owns', 'user'],
  ['machine', 'runs_on', 'job'],
  ['template', 'instance_of', 'machine'],
  ['template', 'running', 'job'],
  ['operation_profile', 'approved_for', 'template'],
  ...MINT_OPERATIONS.map((op) => ['asset', `grants_${op}`, 'operation_profile'] as [string, string, string]),
];
const ASKED: readonly [type: string, relation: string][] = MINT_OPERATIONS.map((op) => ['asset', `can_${op}`]);

/** What the hopper writes and asks for observe (issue #2146): apart, so a model edited before it still decides every other mint. */
const OBSERVE_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['asset', 'grants_observe', 'operation_profile']];
const OBSERVE_ASKED: readonly [type: string, relation: string][] = [['asset', 'can_observe']];

/** What the hopper tells and asks for a relay connection (issue #2146): apart, so a model edited before it still decides mints. */
const BASTION_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['bastion', 'owner', 'job'], ['bastion', 'approved_for', 'template']];
const BASTION_ASKED: readonly [type: string, relation: string][] = [['bastion', 'can_relay']];

/** What the hopper tells and asks for vault grants (issue #652): apart, so a model edited before them still decides mints. */
const VAULT_GRANT_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['vault_grant', 'owner', 'user']];
const VAULT_GRANT_ASKED: readonly [type: string, relation: string][] = [['vault_grant', 'can_grant']];

/** What the hopper tells and asks for search hits (issue #945): apart, so a model edited before them still decides mints. */
const SEARCH_HIT_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['search_hit', 'owner', 'user'], ['search_hit', 'reader', 'user']];
const SEARCH_HIT_ASKED: readonly [type: string, relation: string][] = [['search_hit', 'can_view']];

/** What the hopper tells and asks for a job's terminal (issue #1128): apart, so a model edited before it still decides mints. */
const TERMINAL_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['terminal', 'owner', 'user']];
const TERMINAL_ASKED: readonly [type: string, relation: string][] = [['terminal', 'can_attach']];
const MACHINE_TERMINAL_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['machine_terminal', 'owner', 'user']];
const MACHINE_TERMINAL_ASKED: readonly [type: string, relation: string][] = [['machine_terminal', 'can_attach']];

/** What the hopper writes and asks for artifacts (issue #624): apart, so a model edited before them still decides mints. */
const ARTIFACT_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['artifact', 'viewer', 'user'], ['artifact', 'viewer', 'link']];
const ARTIFACT_ASKED: readonly [type: string, relation: string][] = [['artifact', 'can_view']];

/** What the hopper tells and asks for a system secret (issue #657): apart, so a model edited before them still decides mints. */
const SYSTEM_SECRET_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['system_secret', 'owner', 'user'], ['system_secret', 'admin', 'user']];
const SYSTEM_SECRET_ASKED: readonly [type: string, relation: string][] = [['system_secret', 'can_change'], ['system_secret', 'can_read']];

/** What the hopper tells and asks for a shared secret (issue #718): apart, so a model edited before them still decides mints. */
const SHARED_SECRET_WRITTEN: readonly [type: string, relation: string, accepts: string][] = [['shared_secret', 'admin', 'user'], ['shared_secret', 'reader', 'user']];
const SHARED_SECRET_ASKED: readonly [type: string, relation: string][] = [['shared_secret', 'can_change'], ['shared_secret', 'can_read']];

/** Each relation the hopper needs that the model lacks (`type#relation`) or no longer lets it write (`… accepts type`); empty: none. */
export function modelGaps(model: ModelJson): string[] {
  return gapsIn(model, WRITTEN, ASKED);
}

/** What the model lacks for observe (issue #2146); empty: observe is decided. A gap here denies every observe, and no other mint. */
export function observeGaps(model: ModelJson): string[] {
  return gapsIn(model, OBSERVE_WRITTEN, OBSERVE_ASKED);
}

/** The tuples OpenFGA takes under a model with these observe gaps: none of observe's grants when it lacks them (issue #2146). */
export const observeKept = <T extends { relation: string }>(tuples: T[], gaps: readonly string[]): T[] => (gaps.length === 0 ? tuples : tuples.filter((t) => t.relation !== 'grants_observe'));

/** What the model lacks for relay connections (issue #2146); empty: they are decided. A gap here denies every relay, never a mint. */
export function bastionGaps(model: ModelJson): string[] {
  return gapsIn(model, BASTION_WRITTEN, BASTION_ASKED);
}

/** What the model lacks for artifacts (issue #624); empty: shares are decided. A gap here denies every share, never a mint. */
export function artifactGaps(model: ModelJson): string[] {
  return gapsIn(model, ARTIFACT_WRITTEN, ARTIFACT_ASKED);
}

/** What the model lacks for system secrets (issue #657); empty: they are decided. A gap here denies every change and read, never a mint. */
export function systemSecretGaps(model: ModelJson): string[] {
  return gapsIn(model, SYSTEM_SECRET_WRITTEN, SYSTEM_SECRET_ASKED);
}

/** What the model lacks for shared secrets (issue #718); empty: they are decided. A gap here denies every change and read, never a mint. */
export function sharedSecretGaps(model: ModelJson): string[] {
  return gapsIn(model, SHARED_SECRET_WRITTEN, SHARED_SECRET_ASKED);
}

/** What the model lacks for API tokens (issue #718); empty: their uses are decided. A gap here denies every use, never a mint. */
export function apiTokenGaps(model: ModelJson): string[] {
  return gapsIn(model, API_TOKEN_WRITTEN, API_TOKEN_ASKED);
}

/** What the model lacks for box actions (issue #795); empty: they are decided. A gap here refuses every box action, nothing else. */
export function apiTokenBoxGaps(model: ModelJson): string[] {
  return gapsIn(model, API_TOKEN_BOX_WRITTEN, API_TOKEN_BOX_ASKED);
}

/** What the model lacks for items (issue #662); empty: accepting new text is decided. A gap here denies every acceptance, never a mint. */
export function itemGaps(model: ModelJson): string[] {
  return gapsIn(model, ITEM_WRITTEN, ITEM_ASKED);
}

/** What the model lacks for intake (issue #652); empty: trusted actors are decided. A gap here makes every issue a request card, never denies a mint. */
export function intakeGaps(model: ModelJson): string[] {
  return gapsIn(model, INTAKE_WRITTEN, INTAKE_ASKED);
}

/** What the model lacks for intake on GitLab (issue #1448); empty: GitLab's trusted actors are decided. A gap: no GitLab issue is a job. */
export function gitlabIntakeGaps(model: ModelJson): string[] {
  return gapsIn(model, GITLAB_INTAKE_WRITTEN, INTAKE_ASKED);
}

/** What the model lacks for vault grants (issue #652); empty: grants are decided. A gap here denies every grant, never a mint. */
export function vaultGrantGaps(model: ModelJson): string[] {
  return gapsIn(model, VAULT_GRANT_WRITTEN, VAULT_GRANT_ASKED);
}

/** What the model lacks for search hits (issue #945); empty: hits are decided. A gap here hides every hit, never denies a mint. */
export function searchHitGaps(model: ModelJson): string[] {
  return gapsIn(model, SEARCH_HIT_WRITTEN, SEARCH_HIT_ASKED);
}

/** What the model lacks for a job's terminal (issue #1128); empty: attaching is decided. A gap here denies every attach, never a mint. */
export function terminalGaps(model: ModelJson): string[] {
  return gapsIn(model, TERMINAL_WRITTEN, TERMINAL_ASKED);
}

/** What the model lacks for a machine's terminal (issue #1128); empty: attaching is decided. A gap here denies every attach. */
export function machineTerminalGaps(model: ModelJson): string[] {
  return gapsIn(model, MACHINE_TERMINAL_WRITTEN, MACHINE_TERMINAL_ASKED);
}

/** What the model lacks for trust (issue #655, part 15); empty: jobs hold their trust. A gap: no trust tuple, and no minimum trust. */
export function trustGaps(model: ModelJson): string[] {
  return gapsIn(model, TRUST_WRITTEN, []);
}

function gapsIn(model: ModelJson, written: typeof WRITTEN, asked: typeof ASKED): string[] {
  const def = (type: string) => model.type_definitions.find((t) => t.type === type);
  const gaps: string[] = [];
  for (const [type, relation, accepts] of written) {
    const t = def(type);
    if (!t?.relations?.[relation]) { gaps.push(`${type}#${relation}`); continue; }
    const direct = t.metadata?.relations?.[relation]?.directly_related_user_types ?? [];
    if (!direct.some((d) => d.type === accepts)) gaps.push(`${type}#${relation} accepts ${accepts}`);
  }
  for (const [type, relation] of asked) if (!def(type)?.relations?.[relation]) gaps.push(`${type}#${relation}`);
  return gaps;
}
