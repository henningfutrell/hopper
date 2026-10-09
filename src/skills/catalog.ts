// The skills the hopper has (issue #582, design.md "Skills: what the hopper can set up for a box"): baked in, each a
// name, one line for the catalog, and the full text a job reads only when it loads the skill. A skill that sets up a
// link to an asset names the operation Access (issue #559) must allow on it and the asset kinds it takes; its link is
// a vault secret of the box's template, given just in time through the vault's helper (issue #558). Pure.
import type { AssetKind, Operation } from '../domain/access.ts';
import { PROXY_HELP } from '../github-proxy/script.ts';

/** How the link's credential reaches the tool: the form of the vault's helper (`$HOPPER_SECRET <form> NAME`). */
export type LinkForm = 'kube' | 'aws';

export interface Skill {
  name: string;
  /** The catalog's line: what it sets up, short. */
  line: string;
  /** The full text: sent only when a job loads the skill. */
  text: string;
  /** A link to an asset: the operation Access must allow, the asset kinds, how they are written, the helper's form. Absent: the text is all. */
  link?: { operation: Operation; kinds: readonly AssetKind[]; example: string; form: LinkForm };
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
  },
  {
    name: 'aws-diagnostics',
    line: 'read-only AWS access to an account or a role (ASSET: aws-account/ID or aws-role/ID/ROLE)',
    text: AWS_TEXT,
    link: { operation: 'read', kinds: ['aws-account', 'aws-role'], example: 'aws-account/ID', form: 'aws' },
  },
];

export const skillOf = (name: string): Skill | undefined => SKILLS.find((s) => s.name === name);

/** The catalog: one line per skill, then how to load one. Few tokens: the full text waits for a load. */
export function catalogText(): string {
  return `${SKILLS.map((s) => `${s.name}: ${s.line}`).join('\n')}\nLoad one: sh "$HOPPER_SKILL" NAME [ASSET]\n`;
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
