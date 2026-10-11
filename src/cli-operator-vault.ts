// The vault, its templates and the sandbox boxes from the operator CLI (issue #716, design.md "The vault and sandbox
// boxes from the operator CLI"): an agent sets a vault secret, saves and approves a template, sets the read policy
// (issue #716, item 1), tests an AWS minting credential (issue #781), and launches a box of it without a UI session in a browser. Each is the UI's own read or `POST /ui/api/vault` / `POST /ui/api/machines/sandbox`,
// so the vault's checks and its approval gate apply as they do for a click. A secret's value comes from stdin only.
import { parseArgs } from 'node:util';
import { ASSET_KINDS, OPERATIONS, type AssetKind, type Operation, type OperationProfile } from './domain/access.ts';
import type { VaultView } from './domain/vault.ts';
import { OperatorRefusal, usage, type Call } from './cli-operator-call.ts';

export const VAULT_USAGE = `  hopper vault                                       the vault: its secrets and templates, with what waits for a person; never a value
  hopper vault set <name> [--scope <text>]           set a vault secret from stdin (never as an argument); kept sealed, never answered back
  hopper vault set <name> --shared [--scope <text>] [--reader <user id>]...
                                                     share a secret with every user's agents, or the readers named (the hopper's admin)
  hopper vault remove <name> [--shared]              remove a vault secret, or a shared secret
  hopper vault mint-test aws-role/<account>/<role>   mint a read session from the account's minting credential and show
                                                     the role and session name STS says it is (sts get-caller-identity)
  hopper template list                               the templates: image, secrets, operation profiles, what each gives and what waits
  hopper template save <name> --image <image> [--secret <name>]... [--profile <operation>/<kind>/<asset>]...
                    [--cpus <default>:<max>] [--memory-mb <default>:<max>] [--ttl-minutes [<default>]:[<max>]] [--keep-home on|off]
                    [--tool aws|helm|kubectl|terraform]...
                                                     save a template; what is left out keeps what it has. A new scope, image,
                                                     tool or profile waits for approve
  hopper template approve <name>                     approve it as it is: its image, its secrets and its read profiles
  hopper template approve-profile <name> <operation>/<kind>/<asset>
                                                     approve one write, sync or apply profile explicitly
  hopper template revoke <name>                      revoke its approval: its boxes take no new job and are given nothing
  hopper template remove <name>                      remove it (refused while a box of it is attached)
  hopper template check <name>                       run its read-only check again (a template a job asked for with
                                                     read needs only): its boxes wait until it passed
  hopper template read-policy [set [<kind>/<asset>|<kind>/<prefix>*]...]
                                                     the read policy: the assets read is approved on with no person, for a
                                                     template a job asks for; set replaces it, set with none clears it
  hopper sandbox list                                the user's sandbox boxes, and whether the hopper can start one now
  hopper sandbox launch [--template <name>] [--secret <name>]... [--cpus <n>] [--memory-mb <n>] [--ttl-minutes <n>] [--profile <p>]
                    [--tool <name>]...
                                                     start a sandbox box, of an approved template, within its limits; with
                                                     fewer of its tools, or any tool on a box of no template`;

const VAULT_SET = 'vault set <name> [--scope <text>] [--shared [--reader <user id>]...] (the value on stdin, never as an argument)';
const VAULT_MINT_TEST = 'vault mint-test aws-role/<account>/<role>';
const VAULT_VERBS = `vault | hopper ${VAULT_SET} | hopper vault remove <name> [--shared] | hopper ${VAULT_MINT_TEST}`;
const TEMPLATE_SAVE = 'template save <name> --image <image> [--secret <name>]... [--profile <operation>/<kind>/<asset>]... [--cpus <d>:<max>] [--memory-mb <d>:<max>] [--ttl-minutes [<d>]:[<max>]] [--keep-home on|off] [--tool <name>]...';
const TEMPLATE_VERBS = 'template list | save <name> … | approve <name> | approve-profile <name> <operation>/<kind>/<asset> | revoke <name> | remove <name> | check <name> | read-policy [set <entry>...]';
const SANDBOX_VERBS = 'sandbox list | launch [--template <name>] [--secret <name>]... [--cpus <n>] [--memory-mb <n>] [--ttl-minutes <n>] [--profile <p>] [--tool <name>]...';

const edit = (body: Record<string, unknown>): Call => ({ role: 'admin', path: '/ui/api/vault', body: async () => body });

/** A shared secret's edit (issue #718): the hopper's admin's route, `POST /ui/api/vault/shared`. */
const shared = (body: Record<string, unknown>): Call => ({ role: 'admin', path: '/ui/api/vault/shared', body: async () => body });

export function vaultCall(args: string[], stdin: () => string): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { scope: { type: 'string' }, shared: { type: 'boolean' }, reader: { type: 'string', multiple: true } } });
  const [verb, name, ...extra] = positionals;
  const flags = Object.keys(values).length > 0;
  if (verb === undefined && !flags) return { role: 'viewer', path: '/api/vault' };
  if (values.reader && !values.shared) throw new OperatorRefusal('--reader names who may read a shared secret: add --shared');
  // A mint test (issue #781): the vault mints a read session and STS says who it is; never a key.
  if (verb === 'mint-test') {
    if (!name || extra.length > 0 || flags) throw usage(VAULT_MINT_TEST);
    return { role: 'admin', path: '/ui/api/vault/mint-test', body: async () => ({ asset: name }) };
  }
  if (verb === 'remove' && name && extra.length === 0 && values.scope === undefined && !values.reader) return (values.shared ? shared : edit)({ action: 'remove', name });
  if (verb !== 'set' || !name || extra.length > 0) throw usage(verb === 'set' ? VAULT_SET : VAULT_VERBS);
  const value = stdin().trim();
  if (!value) throw new OperatorRefusal(`no value on stdin: pipe it in, e.g. hopper vault set ${name} < value-file`);
  const body = { action: 'set', name, value, ...(values.scope === undefined ? {} : { scope: values.scope }) };
  return values.shared ? shared({ ...body, ...(values.reader ? { readers: values.reader } : {}) }) : edit(body);
}

/** `<operation>/<kind>/<asset>`, the key a launch names a profile by; the asset may hold `/` (a namespace, an AWS role). */
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

/** `<default>:<max>`; for the time limit either side may be left out. */
function rangeOf(flag: string, raw: string | undefined, optional: boolean): { default?: number; max?: number } | undefined {
  if (raw === undefined) return undefined;
  const [d, m, ...extra] = raw.split(':');
  if (m === undefined || extra.length > 0 || (!optional && (!d || !m)) || (!d && !m)) {
    throw new OperatorRefusal(`--${flag} ${raw}: write ${optional ? '[<default>]:[<max>]' : '<default>:<max>'}, e.g. 2:4`);
  }
  return { ...(d ? { default: numberOf(flag, d) } : {}), ...(m ? { max: numberOf(flag, m) } : {}) };
}

function limitsOf(values: { cpus?: string | undefined; 'memory-mb'?: string | undefined; 'ttl-minutes'?: string | undefined; 'keep-home'?: string | undefined }) {
  const cpus = rangeOf('cpus', values.cpus, false);
  const memoryMb = rangeOf('memory-mb', values['memory-mb'], false);
  const ttlMinutes = rangeOf('ttl-minutes', values['ttl-minutes'], true);
  const keep = values['keep-home'];
  if (keep !== undefined && keep !== 'on' && keep !== 'off') throw new OperatorRefusal(`--keep-home must be on or off; not ${keep}`);
  const limits = { ...(cpus ? { cpus } : {}), ...(memoryMb ? { memoryMb } : {}), ...(ttlMinutes ? { ttlMinutes } : {}), ...(keep ? { keepHome: keep === 'on' } : {}) };
  return Object.keys(limits).length ? limits : undefined;
}

const templatesOf = (v: unknown) => (v as VaultView).templates;
const readPolicyOf = (v: unknown) => (v as VaultView).readPolicy ?? [];

export function templateCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    image: { type: 'string' }, secret: { type: 'string', multiple: true }, profile: { type: 'string', multiple: true },
    cpus: { type: 'string' }, 'memory-mb': { type: 'string' }, 'ttl-minutes': { type: 'string' }, 'keep-home': { type: 'string' },
    tool: { type: 'string', multiple: true },
  } });
  const [verb, name, ...rest] = positionals;
  const flags = Object.keys(values).length > 0;
  if (verb === 'list' && !name && !flags) return { role: 'viewer', path: '/api/vault', pick: templatesOf };
  // The read policy (issue #716): shown, or replaced by the entries named (none clears it).
  if (verb === 'read-policy' && !flags) {
    if (name === undefined) return { role: 'viewer', path: '/api/vault', pick: readPolicyOf };
    if (name === 'set') return { ...edit({ action: 'set-read-policy', assets: rest }), pick: readPolicyOf };
    throw usage(TEMPLATE_VERBS);
  }
  if (verb === 'save') {
    if (!name || rest.length > 0 || !values.image) throw usage(TEMPLATE_SAVE);
    const profiles = values.profile?.map(profileOf);
    const limits = limitsOf(values);
    const { image, secret, tool } = values;
    return {
      role: 'admin', path: '/ui/api/vault', pick: templatesOf,
      // The secrets left out keep the ones it has, as its profiles and limits do.
      body: async (get) => ({
        action: 'save-template', name, image,
        secrets: secret ?? templatesOf(await get('/api/vault')).find((x) => x.name === name)?.secrets ?? [],
        ...(profiles ? { profiles } : {}), ...(limits ? { limits } : {}), ...(tool ? { tools: tool } : {}),
      }),
    };
  }
  if (!name || flags) throw usage(TEMPLATE_VERBS);
  if (verb === 'approve-profile' && rest.length === 1) return { ...edit({ action: 'approve-profile', name, ...profileOf(rest[0]!) }), pick: templatesOf };
  const action = { approve: 'approve-template', revoke: 'revoke-template', remove: 'remove-template', check: 'check-template' }[verb as string];
  if (action && rest.length === 0) return { ...edit({ action, name }), pick: templatesOf };
  throw usage(TEMPLATE_VERBS);
}

export function sandboxCall(args: string[]): Call {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    template: { type: 'string' }, secret: { type: 'string', multiple: true }, cpus: { type: 'string' }, 'memory-mb': { type: 'string' },
    'ttl-minutes': { type: 'string' }, profile: { type: 'string' }, tool: { type: 'string', multiple: true },
  } });
  const [verb, ...extra] = positionals;
  if (verb === 'list' && extra.length === 0 && Object.keys(values).length === 0) return { role: 'viewer', path: '/api/sandboxes' };
  if (verb !== 'launch' || extra.length > 0) throw usage(SANDBOX_VERBS);
  const num = (flag: 'cpus' | 'memory-mb' | 'ttl-minutes') => (values[flag] === undefined ? undefined : numberOf(flag, values[flag]));
  const cpus = num('cpus');
  const memoryMb = num('memory-mb');
  const ttlMinutes = num('ttl-minutes');
  const params = {
    ...(values.secret ? { secrets: values.secret } : {}), ...(cpus === undefined ? {} : { cpus }), ...(memoryMb === undefined ? {} : { memoryMb }),
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }), ...(values.profile === undefined ? {} : { profile: values.profile }),
    ...(values.tool ? { tools: values.tool } : {}),
  };
  return { role: 'admin', path: '/ui/api/machines/sandbox', body: async () => ({ ...(values.template === undefined ? {} : { template: values.template }), params }) };
}
