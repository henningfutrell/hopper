// The vault, its templates and the sandboxes from the operator CLI (issue #716, design.md "The vault and sandbox
// boxes from the operator CLI"): an agent sets a vault secret, saves and approves a template, sets the read policy
// (issue #716, item 1), tests a minting credential (issues #781, #854), grants a job the vault (issue #1089), and asks for the template some needs name (issue #718) without a UI session in a browser. Each is the UI's own read or `POST /ui/api/vault`,
// so the vault's checks and its approval gate apply as they do for a click. A secret's value comes from stdin only.
// What waits for a person — a job's grant ask, a sandbox request — is decided here too (issue #1138), by a person or by a
// delegate approver with its refresh token alone (cli-operator.ts, HOPPER_REFRESH_TOKEN_FILE).
import { parseArgs } from 'node:util';
import { ASSET_KINDS, OPERATIONS, type AssetKind, type Operation, type OperationProfile } from './domain/access.ts';
import { MINTS_FOR_KINDS, mintsForProblem } from './domain/minting.ts';
import type { StateBackend } from './domain/state-backend.ts';
import { unknownAssetText } from './domain/unknown-assets.ts';
import { imageApproved, type VaultView } from './domain/vault.ts';
import { ACTION_USAGE, ACTION_VERBS, actionCall } from './cli-operator-actions.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const VAULT_USAGE = `  hopper vault                                       the vault: its secrets and templates, with what waits for a person; never a value
  hopper vault set <name> [--scope <text>]           set a vault secret from stdin (never as an argument); kept sealed, never answered back
                  [--mints aws-account/<account id>|cluster/<name>|none]
                                                     make it a minting credential for an AWS account or a cluster (none:
                                                     a plain secret again; left out: it keeps what it mints for)
  hopper vault set <name> --shared [--scope <text>] [--reader <user id>]...
                                                     share a secret with every user's agents, or the readers named (the hopper's admin)
  hopper vault remove <name> [--shared]              remove a vault secret, or a shared secret
  hopper vault grant <job>                           grant a job the vault (its item's jobs): a grant ask in hopper vault
  hopper vault revoke <job>                          take a job's vault grant back
  hopper vault mint-test aws-role/<account>/<role>   mint a read session from the account's minting credential and show
                                                     the role and session name STS says it is (sts get-caller-identity)
  hopper vault mint-test cluster/<name>              mint a read token from the cluster's minting credential (none: found
                                                     in the AWS accounts, as hopper-read) and show the account, role and
                                                     credential, who the cluster says it is and its namespaces
  hopper template list                               the templates: image, secrets, operation profiles, what each gives and what waits
  hopper template save <name> --image <image> [--secret <name>]... [--profile <operation>/<kind>/<asset>]...
                    [--cpus <default>:<max>] [--memory-mb <default>:<max>]
                    [--tool aws|helm|kubectl|terraform]... [--backend <workspace>=<bucket>[/<key prefix>]@<region>]...
                    [--agent-credential <secret>|none] [--egress <host>:<port>|none]...
                                                     save a template; what is left out keeps what it has. A new scope, image,
                                                     tool, egress host or profile waits for approve. --egress: a host its
                                                     boxes may reach through the egress proxy (none: no host). --backend: the S3 state backend
                                                     of a terraform-workspace profile, which the read-only check probes.
                                                     --agent-credential: one of its secrets, a token from claude setup-token,
                                                     that its boxes start with, signed in
  hopper template approve <name>                     approve it as it is: its image, its secrets and its read profiles
  hopper template approve-profile <name> <operation>/<kind>/<asset>
                                                     approve one write, sync or apply profile explicitly
  hopper template revoke <name>                      revoke its approval: its boxes take no new job and are given nothing
  hopper template remove <name>                      remove it (refused while a box of it is attached)
  hopper template check <name>                       run its read-only check again (a template a job asked for with
                                                     read needs only): its boxes wait until it passed
  hopper template request --needs "<operation>/<kind>/<asset> ..."
                                                     ask for the template the needs name, as a job does: approved with no
                                                     person only when each need is a read the read policy holds; a line
                                                     of needs can be plain words (get pods on cluster lab)
  hopper template read-policy [set [<kind>/<asset>|<kind>/<prefix>*]...]
                                                     the read policy: the assets read is approved on with no person, for a
                                                     template a job asks for; set replaces it, set with none clears it
  hopper grant [list]                                the jobs that wait for a vault grant (grant asks)
  hopper grant approve <job>                         grant a job that waits the vault; a delegate approver's, within its policy
  hopper grant deny <job>                            deny a job's grant ask: it goes, and the job asks no more
  hopper sandbox list                                the user's latest sandbox runs, and the boxes the hopper could not burn
  hopper sandbox requests                            the sandbox runs jobs asked for, waiting or decided
  hopper sandbox approve <request>                   approve a sandbox request: the job's box steps run, each in a sandbox
  hopper sandbox decline <request> --reason <text>   decline a sandbox request: the job is told why
  hopper sandbox runs                                the run cards: each job's run that waits for a person, its template with it
  hopper sandbox approve-run <job> <template> [--allow-again]
                                                     approve a run card once: its template, each profile it lists, the run and its AWS actions;
                                                     for this job only, or with --allow-again for later jobs too
  hopper sandbox decline-run <job> <template> --reason <text>   decline a run card: the job is told why
${ACTION_USAGE}`;

const VAULT_SET = 'vault set <name> [--scope <text>] [--mints <kind>/<name>|none] [--shared [--reader <user id>]...] (the value on stdin, never as an argument)';
const VAULT_MINT_TEST = 'vault mint-test aws-role/<account>/<role>|cluster/<name>';
const VAULT_GRANT = 'vault grant|revoke <job>';
const VAULT_VERBS = `vault | hopper ${VAULT_SET} | hopper vault remove <name> [--shared] | hopper ${VAULT_GRANT} | hopper ${VAULT_MINT_TEST}`;
const TEMPLATE_SAVE = 'template save <name> --image <image> [--secret <name>]... [--profile <operation>/<kind>/<asset>]... [--cpus <d>:<max>] [--memory-mb <d>:<max>] [--tool <name>]... [--backend <workspace>=<bucket>[/<key prefix>]@<region>]... [--agent-credential <secret>|none] [--egress <host>:<port>|none]... [--mark <probe>=expect-denied|skip|none]...';
const TEMPLATE_REQUEST = 'template request --needs "<operation>/<kind>/<asset> ..." (or plain words, one line each: "get pods on cluster lab")';
const TEMPLATE_VERBS = 'template list | save <name> … | request --needs <needs> | approve <name> | approve-profile <name> <operation>/<kind>/<asset> | revoke <name> | remove <name> | check <name> | read-policy [set <entry>...]';
const GRANT_VERBS = 'grant [list] | approve <job> | deny <job>';
const SANDBOX_VERBS = 'sandbox list | requests | approve <request> | decline <request> --reason <text> | runs | approve-run <job> <template> [--allow-again] | decline-run <job> <template> --reason <text>';

const edit = (body: Record<string, unknown>): Call => ({ role: 'admin', path: '/ui/api/vault', body: async () => body });

/** A shared secret's edit (issue #718): the hopper's admin's route, `POST /ui/api/vault/shared`. */
const shared = (body: Record<string, unknown>): Call => ({ role: 'admin', path: '/ui/api/vault/shared', body: async () => body });

export function vaultCall(args: string[], stdin: () => string): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { scope: { type: 'string' }, mints: { type: 'string' }, shared: { type: 'boolean' }, reader: { type: 'string', multiple: true } } });
  const [verb, name, ...extra] = positionals;
  const flags = Object.keys(values).length > 0;
  if (verb === undefined && !flags) return { role: 'viewer', path: '/api/vault' };
  if (values.reader && !values.shared) throw new OperatorRefusal('--reader names who may read a shared secret: add --shared');
  if (values.mints !== undefined && values.shared) throw new OperatorRefusal('--mints: a shared secret mints nothing; set a minting credential without --shared');
  // A mint test (issues #781, #854): the vault mints a read session or token, and STS or the cluster says who it is; never a key.
  if (verb === 'mint-test') {
    if (!name || extra.length > 0 || flags) throw usage(VAULT_MINT_TEST);
    return { role: 'admin', path: '/ui/api/vault/mint-test', body: async () => ({ asset: name }) };
  }
  // A vault grant (issue #1089): the Vault page's Grant and Revoke, `POST /ui/api/jobs/:id/grant-vault|revoke-vault`.
  // Access decides as for a click; the answer is the vault's view.
  if (verb === 'grant' || verb === 'revoke') {
    if (!name || extra.length > 0 || flags) throw usage(VAULT_GRANT);
    return { role: 'operator', path: `/ui/api/jobs/${encodeURIComponent(name)}/${verb}-vault`, body: async () => ({}) };
  }
  if (verb === 'remove' && name && extra.length === 0 && values.scope === undefined && values.mints === undefined && !values.reader) return (values.shared ? shared : edit)({ action: 'remove', name });
  if (verb !== 'set' || !name || extra.length > 0) throw usage(verb === 'set' ? VAULT_SET : VAULT_VERBS);
  const value = stdin().trim();
  if (!value) throw new OperatorRefusal(`no value on stdin: pipe it in, e.g. hopper vault set ${name} < value-file`);
  const mints = values.mints === undefined ? undefined : mintsOf(values.mints);
  const body = { action: 'set', name, value, ...(values.scope === undefined ? {} : { scope: values.scope }), ...(mints === undefined ? {} : { mints }) };
  return values.shared ? shared({ ...body, ...(values.reader ? { readers: values.reader } : {}) }) : edit(body);
}

/** How `--mints` is written: an AWS account, a cluster, or (issue #2231) a database. */
const MINTS_FORMS = 'aws-account/<account id>, cluster/<name> or database/<cluster>/<namespace>/<database>';

/** `--mints aws-account/<account id>|cluster/<name>|database/<name>|none` (issue #791): what a minting credential mints for; none: nothing. */
function mintsOf(raw: string): { kind: string; name: string } | null {
  if (raw === 'none') return null;
  const i = raw.indexOf('/');
  const kind = raw.slice(0, i), name = raw.slice(i + 1);
  if (i < 0 || !(MINTS_FOR_KINDS as readonly string[]).includes(kind) || name === '') throw new OperatorRefusal(`--mints ${raw}: write ${MINTS_FORMS}, or none`);
  const problem = mintsForProblem({ kind, name });
  if (problem) throw new OperatorRefusal(`--mints ${raw}: ${problem}`);
  return { kind, name };
}

/** `<operation>/<kind>/<asset>`, the key a launch names a profile by; the asset may hold `/` (a namespace, an AWS role). */
/** `--backend <workspace>=<bucket>[/<key prefix>]@<region>` (issue #715): a terraform workspace's state backend. */
function backendOf(raw: string): [string, StateBackend] {
  const m = /^([^=]+)=([^/@]+)(?:\/([^@]*))?@(.+)$/.exec(raw);
  if (!m) throw new OperatorRefusal(`--backend ${raw}: write <workspace>=<bucket>[/<key prefix>]@<region>, e.g. shop-prod=shop-state/env/prod@eu-west-1`);
  return [m[1]!, { bucket: m[2]!, region: m[4]!, ...(m[3] ? { keyPrefix: m[3] } : {}) }];
}

/** The profiles with each workspace's backend: the one `--backend` names, else the one the template has (what is left out keeps what it has). */
function withBackends(profiles: OperationProfile[], had: readonly OperationProfile[], raw: readonly string[]): OperationProfile[] {
  const named = new Map(raw.map(backendOf));
  for (const w of named.keys()) {
    if (!profiles.some((p) => p.asset.kind === 'terraform-workspace' && p.asset.name === w)) throw new OperatorRefusal(`--backend ${w}: the template has no terraform-workspace profile ${w}`);
  }
  return profiles.map((p) => {
    const backend = p.asset.kind === 'terraform-workspace' ? named.get(p.asset.name) ?? had.find((h) => h.asset.kind === p.asset.kind && h.asset.name === p.asset.name)?.backend : undefined;
    return backend ? { ...p, backend } : p;
  });
}

function profileOf(raw: string): OperationProfile {
  const [operation, kind, ...rest] = raw.split('/');
  const name = rest.join('/');
  if (!name) throw new OperatorRefusal(`--profile ${raw}: write <operation>/<kind>/<asset>, e.g. read/cluster/prod`);
  if (!(OPERATIONS as readonly string[]).includes(operation!)) throw new OperatorRefusal(`--profile ${raw}: the operation is one of ${OPERATIONS.join(', ')}`);
  if (!(ASSET_KINDS as readonly string[]).includes(kind!)) throw new OperatorRefusal(`--profile ${raw}: the asset kind is one of ${ASSET_KINDS.join(', ')}`);
  return { operation: operation as Operation, asset: { kind: kind as AssetKind, name } };
}

function numberOf(flag: string, raw: string): number {
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n)) throw new OperatorRefusal(`--${flag} must be a number; not ${raw}`);
  return n;
}

/** `<default>:<max>`. */
function rangeOf(flag: string, raw: string | undefined): { default: number; max: number } | undefined {
  if (raw === undefined) return undefined;
  const [d, m, ...extra] = raw.split(':');
  if (!d || !m || extra.length > 0) throw new OperatorRefusal(`--${flag} ${raw}: write <default>:<max>, e.g. 2:4`);
  return { default: numberOf(flag, d), max: numberOf(flag, m) };
}

function limitsOf(values: { cpus?: string | undefined; 'memory-mb'?: string | undefined }) {
  const cpus = rangeOf('cpus', values.cpus);
  const memoryMb = rangeOf('memory-mb', values['memory-mb']);
  const limits = { ...(cpus ? { cpus } : {}), ...(memoryMb ? { memoryMb } : {}) };
  return Object.keys(limits).length ? limits : undefined;
}

const templatesOf = (v: unknown) => (v as VaultView).templates;
/** The templates as `hopper template list` shows them: one with an unknown asset (issue #2067) says so in words. */
const templatesListed = (v: unknown) => templatesOf(v).map((t) => (t.unknownAssets?.length ? { ...t, unknownAsset: `unknown asset: ${t.unknownAssets.map(unknownAssetText).join('; ')}` } : t));
const readPolicyOf = (v: unknown) => (v as VaultView).readPolicy ?? [];
/** What `hopper template check` says (issue #2226): when the check it asked for runs, or why it does not run yet. */
const checkAsked = (name: string) => (v: unknown) => {
  const t = templatesOf(v).find((x) => x.name === name);
  const when = !t ? 'the template is gone' : imageApproved(t) ? 'the next read-only check pass runs it' : `it does not run until its image is approved (hopper template approve ${name})`;
  return { template: name, check: `asked for: ${when}` };
};

/** One `--mark <probe>=<mark>` (issue #916): the probe and its mark, `none` to drop it. The vault checks the probe and the mark. */
function markOf(s: string): [string, string] {
  const at = s.lastIndexOf('=');
  if (at <= 0 || at === s.length - 1) throw usage(TEMPLATE_SAVE);
  return [s.slice(0, at), s.slice(at + 1)];
}

/** The template's probe marks with these changed: the ones it has, each named one set, or dropped by `none`. */
function withMarks(had: Readonly<Record<string, string>>, marks: readonly [string, string][]): Record<string, string> {
  const out = { ...had };
  for (const [probe, mark] of marks) {
    if (mark === 'none') delete out[probe];
    else out[probe] = mark;
  }
  return out;
}

export function templateCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    image: { type: 'string' }, secret: { type: 'string', multiple: true }, profile: { type: 'string', multiple: true }, backend: { type: 'string', multiple: true },
    cpus: { type: 'string' }, 'memory-mb': { type: 'string' },
    tool: { type: 'string', multiple: true }, egress: { type: 'string', multiple: true }, needs: { type: 'string' }, 'agent-credential': { type: 'string' },
    mark: { type: 'string', multiple: true },
  } });
  const [verb, name, ...rest] = positionals;
  const flags = Object.keys(values).length > 0;
  if (verb === 'list' && !name && !flags) return { role: 'viewer', path: '/api/vault', pick: templatesListed };
  // The read policy (issue #716): shown, or replaced by the entries named (none clears it).
  if (verb === 'read-policy' && !flags) {
    if (name === undefined) return { role: 'viewer', path: '/api/vault', pick: readPolicyOf };
    if (name === 'set') return { ...edit({ action: 'set-read-policy', assets: rest }), pick: readPolicyOf };
    throw usage(TEMPLATE_VERBS);
  }
  // A template request (issue #718): what the hopper answers about it, the template's name and whether it is ready.
  if (verb === 'request') {
    const { needs, ...other } = values;
    if (name !== undefined || needs === undefined || Object.keys(other).length > 0) throw usage(TEMPLATE_REQUEST);
    return { ...edit({ action: 'request-template', needs }), pick: (v) => (v as { request: unknown }).request };
  }
  if (verb === 'save') {
    if (!name || rest.length > 0 || !values.image || values.needs !== undefined) throw usage(TEMPLATE_SAVE);
    const profiles = values.profile?.map(profileOf);
    const limits = limitsOf(values);
    const { image, secret, tool, egress, backend, 'agent-credential': credential, mark } = values;
    backend?.forEach(backendOf);
    const marks = mark?.map(markOf);
    return {
      role: 'admin', path: '/ui/api/vault', pick: templatesOf,
      // The secrets left out keep the ones it has, as its profiles, their backends and limits do.
      body: async (get) => {
        const was = templatesOf(await get('/api/vault')).find((x) => x.name === name);
        const declared = profiles ?? (backend ? was?.profiles ?? [] : undefined);
        return {
          action: 'save-template', name, image, secrets: secret ?? was?.secrets ?? [],
          ...(declared ? { profiles: withBackends(declared, was?.profiles ?? [], backend ?? []) } : {}), ...(limits ? { limits } : {}), ...(tool ? { tools: tool } : {}),
          ...(egress ? { egress: egress.filter((h) => h !== 'none') } : {}),
          ...(credential !== undefined ? { agentCredential: credential === 'none' ? null : credential } : {}),
          ...(marks ? { probeMarks: withMarks(was?.probeMarks ?? {}, marks) } : {}),
        };
      },
    };
  }
  if (!name || flags) throw usage(TEMPLATE_VERBS);
  if (verb === 'approve-profile' && rest.length === 1) return { ...edit({ action: 'approve-profile', name, ...profileOf(rest[0]!) }), pick: templatesOf };
  const action = { approve: 'approve-template', revoke: 'revoke-template', remove: 'remove-template', check: 'check-template' }[verb as string];
  if (action && rest.length === 0) return { ...edit({ action, name }), pick: verb === 'check' ? checkAsked(name) : templatesOf };
  throw usage(TEMPLATE_VERBS);
}

/**
 * `hopper grant [list] | approve <job> | deny <job>` (issue #1138): a job's grant ask on Access requests, decided with
 * `POST /ui/api/jobs/:id/grant-vault|deny-vault`. Access decides as for a click; the answer is the vault's view.
 */
export function grantCall(args: string[]): Call {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [verb, job, ...extra] = positionals;
  if ((verb === undefined || verb === 'list') && job === undefined) return { role: 'viewer', path: '/api/vault', pick: (v) => (v as VaultView).grantAsks ?? [] };
  if ((verb !== 'approve' && verb !== 'deny') || !job || extra.length > 0) throw usage(GRANT_VERBS);
  return { role: 'operator', path: `/ui/api/jobs/${encodeURIComponent(job)}/${verb === 'approve' ? 'grant' : 'deny'}-vault`, body: async () => ({}) };
}

export function sandboxCall(args: string[]): Call {
  // Issue #2206: a job's asks for an AWS action and the grants.
  if (ACTION_VERBS.includes(args[0] ?? '')) return actionCall(args);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { reason: { type: 'string' }, 'allow-again': { type: 'boolean' } } });
  const [verb, ...extra] = positionals;
  if (verb === 'list' && extra.length === 0 && Object.keys(values).length === 0) return { role: 'viewer', path: '/api/sandboxes' };
  // A sandbox request (issues #991, #1138): what jobs asked for, approved or declined as on Access requests.
  if (verb === 'requests' && extra.length === 0 && Object.keys(values).length === 0) return { role: 'viewer', path: '/api/vault', pick: (v) => (v as VaultView).sandboxRequests ?? [] };
  // A run card (issue #2197): one job's run that waits for a person, its template's approval with it, decided once.
  if (verb === 'runs' && extra.length === 0 && Object.keys(values).length === 0) return { role: 'viewer', path: '/api/vault', pick: (v) => (v as VaultView).runs ?? [] };
  if (verb === 'approve-run' || verb === 'decline-run') {
    // Part 3: --allow-again approves the access for later jobs too; with none, for this job's runs only.
    const { reason, 'allow-again': again, ...other } = values;
    const [job, template, ...more] = extra;
    if (!job || !template || more.length > 0 || Object.keys(other).length > 0 || (verb === 'approve-run') !== (reason === undefined) || (again && verb !== 'approve-run')) throw usage(SANDBOX_VERBS);
    const runs = (v: unknown) => (v as VaultView).runs ?? [];
    return { role: 'admin', path: '/ui/api/sandbox-requests', pick: runs, body: async () => (verb === 'approve-run' ? { action: verb, job, template, ...(again ? { allowAgain: true } : {}) } : { action: verb, job, template, reason }) };
  }
  if (verb === 'approve' || verb === 'decline') {
    const { reason, ...other } = values;
    const [id, ...more] = extra;
    if (!id || more.length > 0 || Object.keys(other).length > 0 || (verb === 'approve') !== (reason === undefined)) throw usage(SANDBOX_VERBS);
    const requests = (v: unknown) => (v as VaultView).sandboxRequests ?? [];
    return { role: 'admin', path: '/ui/api/sandbox-requests', pick: requests, body: async () => (verb === 'approve' ? { action: 'approve', id } : { action: 'decline', id, reason }) };
  }
  throw usage(SANDBOX_VERBS);
}
