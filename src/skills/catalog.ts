// The skills the hopper has (issue #582, design.md "Skills: what the hopper can set up for a box"): baked in, each a
// name, one line for the catalog, and the full text a job reads only when it loads the skill. A skill that sets up a
// link to an asset names the operation Access (issue #559) must allow on it and the asset kinds it takes; its link is
// a vault secret of the box's template, given just in time through the vault's helper (issue #558). A skill that needs a
// credential says the kinds it takes and how a person gets one: when the box's template gives none, the vault asks a
// person for it (issue #583, design.md "The dynamic vault"). Pure.
import type { AssetKind, Operation } from '../domain/access.ts';
import { ARTIFACT_HELP } from '../artifacts/script.ts';
import { PROXY_HELP } from '../github-proxy/script.ts';
import { BOX_STEP_HELP, NEED_STEP_HELP, STEP_HELP } from '../windows-steps/script.ts';

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

// Issue #1905: what a job reads with its own token, from wherever it runs: never 127.0.0.1, which is the job's own machine.
const TOPOLOGY_TEXT = `topology: the infrastructure topology, read-only: the services in the user's AWS accounts and Kubernetes clusters, and what is linked to what.

Read it: printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS --fail -H @- "$HOPPER_URL/job/topology"
It is JSON: nodes (id, kind, name, account, region, cluster, namespace, aliases, attrs, seen), links (from, to, kind) and
sources (each source's key, when it was read last, and why it is stale). Filter it with jq. It is what the hopper found at
its last read: to read an account or a cluster now, ask for aws-diagnostics or kube-diagnostics.`;

// Issue #2167: a job parks or picks up its user's proposal or research report with its own token (src/http/job-park.ts).
const PARK_TEXT = `park: set a proposal or a research report aside, and pick it up again. It keeps its state and output.

Your token goes in a header from stdin, never on the command line:
List the open ones, parked or not: printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS -H @- "$HOPPER_URL/job/park"
Park one: printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS -H @- -H 'content-type: application/json' -d '{"act":"park","item":"ID","reason":"WHY"}' "$HOPPER_URL/job/park"
Pick it up: the same, with "act":"pick-up". It waits on a decision again, as before.
You park only an item whose job waits on it. You pick up only an item a job parked: a person's park stays.
A parked item gets no review and no decision. A decision is a person's: you never take one.`;

// Issue #2146: how a job reads a cluster's metrics and logs through its bastion (part 4 of the bastion path,
// design.md "Bastions"): the template with an observe and its targets, the bastion, and the relay (src/sandbox/relay-script.ts).
// Part 6: Grafana's API through a bastion read, its Viewer token a vault secret kept in the bastion's box (bastion-read.ts).
const OBSERVABILITY_TEXT = `observability: read the live metrics and logs of a cluster (Prometheus, Loki; Alertmanager and Tempo when it has them) through a bastion. Read only.

1. Find the services once: sh "$HOPPER_STEP" need "read/namespace/CLUSTER/monitoring" --why "<why>" --command 'kubectl get svc'
2. Ask once for a template with an observe on that namespace, and each service as a target, <cluster>/<namespace>/<svc|pod|deploy>/<name>:<port>.
   A person approves it and its targets, then its read-only check runs:
   sh "$HOPPER_SKILL" sandbox-template --why "<why>" --needs "observe/namespace/CLUSTER/monitoring" --targets "CLUSTER/monitoring/svc/prometheus:9090 CLUSTER/monitoring/svc/loki:3100" --wait
3. Start the bastion. Its box holds kubectl port-forward to each target, and its tokens, which you never get:
   sh "$HOPPER_SKILL" bastion --template TEMPLATE --targets "<the same targets>" --why "<why>" --wait
   sh "$HOPPER_SKILL" bastion says where it stands. It ends an hour after its last use, when this job ends, or with: sh "$HOPPER_SKILL" bastion stop
4. Reach a target from here through the hopper's relay. It holds a local port while the command runs, then closes it:
   sh "$HOPPER_RELAY" TARGET -- COMMAND   (the command finds the port in $HOPPER_RELAY_PORT; put a long command in a script file)

PromQL, instant: mkdir -p out && sh "$HOPPER_RELAY" CLUSTER/monitoring/svc/prometheus:9090 -- sh -c 'curl -sSfG http://127.0.0.1:$HOPPER_RELAY_PORT/api/v1/query --data-urlencode query=up -o out/up.json'
PromQL, range: curl -sSfG http://127.0.0.1:$HOPPER_RELAY_PORT/api/v1/query_range --data-urlencode "query=<PromQL>" --data-urlencode start=<unix time> --data-urlencode end=<unix time> --data-urlencode step=60
  Or, when this machine has promtool: promtool query range --start=<RFC 3339> --end=<RFC 3339> --step=1m http://127.0.0.1:$HOPPER_RELAY_PORT '<PromQL>'
LogQL: curl -sSfG http://127.0.0.1:$HOPPER_RELAY_PORT/loki/api/v1/query_range --data-urlencode 'query={namespace="NS"} |= "error"' --data-urlencode since=1h --data-urlencode limit=200 -o out/logs.json
  Or, when this machine has logcli: logcli --addr=http://127.0.0.1:$HOPPER_RELAY_PORT query --since=1h --limit=200 --output=jsonl '<LogQL>'
Alertmanager: GET /api/v2/alerts. Tempo: GET /api/search.
Grafana: its API needs a Viewer token, which stays in the bastion's box: you never get it. The hopper runs the read there for you.
  Name the vault secret that holds the token (SECRET) in the template request (--secrets SECRET) and when you start the bastion (--secrets SECRET), then:
  sh "$HOPPER_SKILL" bastion read --targets CLUSTER/monitoring/svc/grafana:80 --secrets SECRET --path "/api/search?query=<words>" > out/dashboards.json
  A dashboard: --path /api/dashboards/uid/<uid>. A panel's query: --path /api/ds/query --data '{"queries":[{"refId":"A","datasource":{"uid":"<uid>"},"expr":"<PromQL>"}],"from":"now-1h","to":"now"}'
  A read is a GET, or a POST to /api/ds/query only. With no token, run a panel's PromQL or LogQL on Prometheus or Loki in its place.
Evidence: keep the JSON, and make a short table of it with jq (jq -r '.data.result[] | [.metric.job, .value[1]] | @tsv' out/up.json). Put both in the pull request or report, or show them as an artifact (sh "$HOPPER_SKILL" artifacts).

Read only: no kubectl exec, no Secret reads, no change in Grafana (no dashboard or alert edits), no silence in Alertmanager. Never print a token.
If the bastion is refused (Forbidden: pods/portforward), the cluster's observe role has view only: that cluster has no hopper metrics read, and the hopper has no other path. Say so; do not look for another credential.
  A job that needs it waits with: on: outside: gated: pods/portforward for hopper-observe on CLUSTER/NAMESPACE.
If the read-only check fails with errors (Unauthorized, kube.get errors too), the cluster does not take the observe role yet: that is no allow and no refusal.`;

// Issue #2231: how a job reads rows of a database through the hopper (design.md "Database reads", src/skills/database-skill.ts).
export const DATABASE_TEXT = `database: read rows of a database through the hopper. Read only. You never get a credential: for each read the hopper makes a login in the database, runs your one SELECT with it, and removes the login after it.

1. Ask once for a template with read on the database. A person approves it on Access requests:
   sh "$HOPPER_SKILL" sandbox-template --why "<why>" --needs "read/database/<cluster>/<namespace>/<database>" --wait
2. Read. The answer is the rows as CSV, with a header line:
   mkdir -p out && sh "$HOPPER_SKILL" database read --template TEMPLATE --database <cluster>/<namespace>/<database> --sql "SELECT id, email FROM app.users ORDER BY id LIMIT 1000" --why "<why>" > out/users.csv

One statement only: a SELECT (or WITH … SELECT, VALUES). The login can change nothing, and the read runs in a read-only transaction.
The login reads only the schemas a person named for the database. A statement stops after 60 s.
An answer of more than 100000 rows or 16 MiB is refused, never cut: page it (WHERE id > <last id> ORDER BY id LIMIT 10000).
Each read and its SQL are on the job's timeline. Put no secret in the SQL.
If no minting credential mints for the database, only a person can add one, on Vault. Say so; do not look for another credential.`;

export const SKILLS: readonly Skill[] = [
  {
    name: 'github',
    line: 'file and read GitHub issues and pull requests, with no login here',
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
  {
    // Issue #991: a box for what the job's work needs: the template, made or reused, then a box of it the hopper starts.
    name: 'sandbox',
    line: 'a box for the needs (--needs "read/cluster/NAME") or a template (--template NAME)',
    // Issue #1001: --why is required; --plan too when a need changes an asset. The person who approves reads both.
    text: 'sandbox: sh "$HOPPER_SKILL" sandbox --why "<why the job needs it, one or two sentences>" [--plan "<the commands; for each change, what it changes and whether it can be undone>"] (--needs "<operation>/<kind>/<asset> ..." | --template NAME) [--wait]\nA brief that names a template: give --template NAME. The hopper asks for the sandboxes a brief names before the job starts, so they are often approved already.\nIssue #1875: [--secrets "NAME ..."] [--egress "host:port ..."] [--image test] ask for vault secrets, the hosts its sandboxes may reach and the hopper\'s test image (Python, Playwright with Chromium); with --secrets or --egress, --needs may be left out, and a person always approves it.\nIssue #2146: [--tools "jq promtool logcli"] adds box tools beside the ones the needs use.',
  },
  {
    // Issue #716: the template a job's work needs, made by the hopper (src/skills/template-request.ts answers it).
    name: 'sandbox-template',
    line: 'its template only',
    text: 'sandbox-template: sh "$HOPPER_SKILL" sandbox-template --why "<why>" [--plan "<the plan>"] --needs "<operation>/<kind>/<asset> ..." [--secrets "NAME ..."] [--egress "host:port ..."] [--image test] [--tools "TOOL ..."] [--actions "<service:Action>=<resource ARN> ..."] [--wait]\nIssue #2206: --actions names the AWS actions its one change on an aws-role does. The hopper checks each before it makes the template: one the role does not allow is refused, with the need to ask for on hopper-action in its place; one on hopper-action that no grant covers is asked of a person now.',
  },
  {
    // Issue #624: what a job makes for a person to see. Needs no access: the job's own token is enough.
    name: 'artifacts',
    line: 'show a person a visual (a diagram, a chart)',
    text: ARTIFACT_HELP,
  },
  {
    // Issue #731: one step on a Windows host, run by the hopper over ssh; `hopper-step` (src/windows-steps/script.ts).
    name: 'windows-step',
    line: 'run a step on a Windows host (a build, tests)',
    text: STEP_HELP,
  },
  {
    // Issue #1004: one step in a sandbox of the template this job's sandbox request was approved for, made for the step and
    // burned after it (issue #1349); `hopper-step box` (src/windows-steps/script.ts).
    name: 'box-step',
    line: 'run a step in a sandbox of this job\'s approved template',
    text: BOX_STEP_HELP,
  },
  {
    // Issue #1007: one command that needs an account or a cluster, run by the hopper in a one-shot need box with credentials
    // it mints for it; the job stays on its machine. `hopper-step need` (src/windows-steps/script.ts).
    name: 'need-step',
    line: 'run one AWS or Kubernetes command from here, with minted credentials',
    text: NEED_STEP_HELP,
  },
  {
    // Issue #2146: PromQL and LogQL queries through the job's bastion; text only, as the bastion ask gives the access.
    name: 'observability',
    line: 'PromQL, LogQL and Grafana reads through a bastion',
    text: OBSERVABILITY_TEXT,
  },
  {
    // Issue #2231: a database read; `database read` runs one (src/skills/database-skill.ts).
    name: 'database',
    line: 'read rows of a database as CSV: one SELECT, read only',
    text: DATABASE_TEXT,
  },
  {
    // Issue #1905: the user's topology, read with the job's own token (src/http/job-topology.ts).
    name: 'topology',
    line: 'a read-only map of the AWS accounts and clusters',
    text: TOPOLOGY_TEXT,
  },
  {
    // Issue #2167: park and pick up a proposal or research report, with the job's own token (src/http/job-park.ts).
    name: 'park',
    line: 'set a proposal or research report aside; pick it up',
    text: PARK_TEXT,
  },
  {
    // Issue #782: the hopper's help pages, for this version (src/help/book.ts answers it, the page its asset).
    name: 'help',
    line: 'how the hopper works (PAGE: one; none lists them)',
    text: 'help: sh "$HOPPER_SKILL" help [PAGE]',
  },
];

/**
 * The built-in library skills a job may also load by name (issue #1909, src/skills/library.ts), each with its catalog
 * line: the skill library's files (issue #1911), so one text exists.
 */
export const SERVED_LINES = {
  work: 'plan tasks; change; fan out sub-tasks; wait; finish (also: orchestrate)',
} as const;

/** Every skill's name: the catalog's, then the served library skills (issue #1909). */
export const SKILL_NAMES: readonly string[] = [...SKILLS.map((s) => s.name), ...Object.keys(SERVED_LINES)];

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
  const lines = [...SKILLS.map((s) => `${s.name}: ${s.line}`), ...Object.entries(SERVED_LINES).map(([name, line]) => `${name}: ${line}`)];
  return `${lines.join('\n')}\nLoad one: sh "$HOPPER_SKILL" NAME [ASSET]\nA credential for any other service: sh "$HOPPER_SKILL" SERVICE --credential "<what it takes>" [--why "<what for>"]\n`;
}

/** "a cluster or namespace": the asset kinds a link takes, in words. */
export const kindsInWords = (kinds: readonly string[]): string => `a ${kinds.length > 1 ? `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}` : kinds[0]}`;

/**
 * What the box writes for its tool when the vault mints the credential (issue #580): the helper asks for a short-lived
 * one for the operation on the asset, and Access decides again each time the tool runs it.
 */
export function mintedLinkText(form: LinkForm, operation: Operation, asset: string): string {
  const stanza = form === 'kube'
    ? `users:\n- name: hopper\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      interactiveMode: Never\n      command: <the value of $HOPPER_SECRET>\n      args: [kube, ${operation}, ${asset}]`
    : `[profile hopper]\ncredential_process = <the value of $HOPPER_SECRET> aws ${operation} ${asset}`;
  return `The vault mints a short-lived credential for ${operation} on ${asset} each time the tool asks. Access decides each one.\n${stanza}`;
}

/** What the box writes for its tool to get the credential from the vault's helper, for each secret it may use. */
export function linkText(form: LinkForm, secrets: readonly { name: string; scope?: string }[]): string {
  const list = secrets.map((s) => `${s.name}${s.scope ? ` (${s.scope})` : ''}`).join(', ');
  const name = secrets.length === 1 ? secrets[0]!.name : 'NAME';
  const stanza = form === 'kube'
    ? `users:\n- name: hopper\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      interactiveMode: Never\n      command: <the value of $HOPPER_SECRET>\n      args: [kube, ${name}]`
    : `[profile hopper]\ncredential_process = <the value of $HOPPER_SECRET> aws ${name}`;
  return `Vault secrets this box may use: ${list}.${secrets.length > 1 ? ' Put the one for this asset in place of NAME.' : ''}\n${stanza}`;
}
