// The skills the hopper has (issue #582, design.md "Skills: what the hopper can set up for a box"): baked in, each a
// name, one line for the catalog, and the full text a job reads only when it loads the skill. A skill that sets up a
// link to an asset names the operation Access (issue #559) must allow on it and the asset kinds it takes; its link is
// a vault secret of the box's template, given just in time through the vault's helper (issue #558). A skill that needs a
// credential says the kinds it takes and how a person gets one: when the box's template gives none, the vault asks a
// person for it (issue #583, design.md "The dynamic vault"). Pure.
import type { AssetKind, Operation } from '../domain/access.ts';
import { PROXY_HELP } from '../github-proxy/script.ts';

/** How the link's credential reaches the tool: the form of the vault's helper (`$HOPPER_SECRET <form> NAME`). */
export type LinkForm = 'kube' | 'aws';

/** One kind of credential a skill takes (issue #583). The first a skill lists is the one the hopper suggests. */
export interface CredentialKind {
  /** `api-key`, `token`, …; a person may always give `other`, in their own words. */
  id: string;
  /** What a person is asked for, in plain words. */
  title: string;
  /** How a job uses it, `NAME` for the vault secret's name. Absent: the skill's link says it. */
  use?: string;
}

/** The credential a skill needs (issue #583): the kinds it takes, and how a person gets one or sets the tool up. */
export interface SkillCredential { kinds: readonly CredentialKind[]; setup: string }

/** How a job uses a credential a person gave in their own words, or one asked for a skill the hopper does not have. */
export const OWN_WORDS_USE = 'Read it with "$HOPPER_SECRET" get NAME, only in the command that needs it. Never print it or write it to a file.';

export interface Skill {
  name: string;
  /** The catalog's line: what it sets up, short. */
  line: string;
  /** The full text: sent only when a job loads the skill. */
  text: string;
  /** A link to an asset: the operation Access must allow, the asset kinds, how they are written, the helper's form. Absent: the text is all. */
  link?: { operation: Operation; kinds: readonly AssetKind[]; example: string; form: LinkForm };
  /** The credential it needs (issue #583): absent, it needs none of its own. */
  credential?: SkillCredential;
}

const KUBE_TEXT = `kube-diagnostics: a read-only link to a Kubernetes cluster or namespace.

The hopper gives the token just in time, through the vault's helper ($HOPPER_SECRET). The token is never on this box.
1. Write a kubeconfig in your scratch dir. Put the cluster's server URL and CA in it. Set its user to the exec stanza below.
2. Use it: KUBECONFIG=<that file> kubectl ...
3. Read only: get, describe, logs, events, top. Do not change anything on the cluster.
If kubectl refuses, the token or its role is wrong. Say so; do not look for another credential.`;

const AWS_TEXT = `aws-diagnostics: read-only AWS access to an account or a role.

The hopper gives the key pair just in time, through the vault's helper ($HOPPER_SECRET). The keys are never on this box.
1. Write an AWS config file in your scratch dir, with a profile that has the credential_process line below.
2. Use it: AWS_CONFIG_FILE=<that file> AWS_PROFILE=hopper aws ...
3. Read only: describe, list, get. Do not change anything in the account.
If AWS refuses, the keys or their policy are wrong. Say so; do not look for another credential.`;

export const SKILLS: readonly Skill[] = [
  {
    name: 'github',
    line: 'file and read GitHub issues and pull requests through the hopper, with no login here',
    text: PROXY_HELP,
  },
  {
    name: 'kube-diagnostics',
    line: 'a read-only link to a Kubernetes cluster or namespace (ASSET: cluster/NAME or namespace/CLUSTER/NS)',
    text: KUBE_TEXT,
    link: { operation: 'read', kinds: ['cluster', 'namespace'], example: 'cluster/NAME', form: 'kube' },
    credential: {
      kinds: [{ id: 'token', title: 'A bearer token for the cluster, read-only (a service account token)' }],
      setup: 'With no kubeconfig or token yet: in the cluster, make a service account with the view role (kubectl create serviceaccount hopper-view; kubectl create clusterrolebinding hopper-view --clusterrole=view --serviceaccount=default:hopper-view), then kubectl create token hopper-view --duration=24h, and give that token. Without kubectl: ask whoever runs the cluster for a read-only token.',
    },
  },
  {
    name: 'aws-diagnostics',
    line: 'read-only AWS access to an account or a role (ASSET: aws-account/ID or aws-role/ID/ROLE)',
    text: AWS_TEXT,
    link: { operation: 'read', kinds: ['aws-account', 'aws-role'], example: 'aws-account/ID', form: 'aws' },
    credential: {
      kinds: [{ id: 'access-key', title: 'An access key pair, read-only, as JSON: {"AccessKeyId": "…", "SecretAccessKey": "…"}' }],
      setup: 'In the AWS console: IAM → Users → a user for the hopper with only the ReadOnlyAccess policy → Security credentials → Create access key. Give the pair as JSON.',
    },
  },
];

export const skillOf = (name: string): Skill | undefined => SKILLS.find((s) => s.name === name);

/** A skill the hopper does not have, asked for in the job's own words (issue #583): what it takes is the suggested kind. */
export function askedSkill(name: string, credential: string): Skill & { credential: SkillCredential } {
  return {
    name, line: 'asked for by a job; the hopper has no skill for it',
    text: `${name}: the hopper has no skill for it. Use the credential as the user described it, one command at a time.`,
    credential: { kinds: [{ id: 'asked', title: credential, use: OWN_WORDS_USE }], setup: 'The hopper has no setup steps for this service: the job said what it takes, above.' },
  };
}

/** How a job uses the vault secret a person gave for a skill (issue #583): its name, the kind, the person's words. */
export function credentialText(c: SkillCredential, s: { name: string; kind?: string; note?: string; scope?: string }): string {
  const kind = c.kinds.find((k) => k.id === s.kind);
  const what = kind?.title ?? (s.note ? 'something the user described' : 'a credential');
  return `Vault secret: ${s.name} — ${what}${s.note ? ` (the user says: ${s.note})` : ''}${s.scope ? `; scope: ${s.scope}` : ''}.\nUse: ${(kind?.use ?? OWN_WORDS_USE).replaceAll('NAME', s.name)}`;
}

/** The catalog: one line per skill, then how to load one. Few tokens: the full text waits for a load. */
export function catalogText(): string {
  return `${SKILLS.map((s) => `${s.name}: ${s.line}`).join('\n')}\nLoad one: sh "$HOPPER_SKILL" NAME [ASSET]\nA credential for any other service: sh "$HOPPER_SKILL" SERVICE --credential "<what it takes>" [--why "<what for>"]\n`;
}

/** "a cluster or namespace": the asset kinds a link takes, in words. */
export const kindsInWords = (kinds: readonly string[]): string => `a ${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : kinds[0]}`;

/** What the box writes for its tool to get the credential from the vault's helper, for each secret it may use. */
export function linkText(form: LinkForm, secrets: readonly { name: string; scope?: string }[]): string {
  const list = secrets.map((s) => `${s.name}${s.scope ? ` (${s.scope})` : ''}`).join(', ');
  const name = secrets.length === 1 ? secrets[0]!.name : 'NAME';
  const stanza = form === 'kube'
    ? `users:\n- name: hopper\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      interactiveMode: Never\n      command: <the value of $HOPPER_SECRET>\n      args: [kube, ${name}]`
    : `[profile hopper]\ncredential_process = <the value of $HOPPER_SECRET> aws ${name}`;
  return `Vault secrets this box may use: ${list}.${secrets.length > 1 ? ' Put the one for this asset in place of NAME.' : ''}\n${stanza}`;
}
