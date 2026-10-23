// The hopper's probes for the read-only check (issue #716, item 4; design.md "The read-only check"): for each asset kind,
// the writes that must be refused and the reads that must work, after the negative suite issue #715 asks for. Each write
// is one that leaves nothing when it is refused, and a dry run where the service has one (EC2 `--dry-run`, Kubernetes
// `--dry-run=server`): a server dry run still asks the API's authorization. A write that goes through is undone by its
// `cleanup`, and the check fails. The catalog is data: issue #715 added the terraform wrapper's probes here.
import type { OperationProfile } from '../domain/access.ts';
import type { Probe, ProbeCatalog, ProbeRun } from '../domain/read-only-check.ts';
import { stateProbeKey } from '../domain/state-backend.ts';

/** The words of a refusal from AWS, Kubernetes, helm, terraform, or a read-only wrapper on PATH. */
export const DENIAL = /AccessDenied|UnauthorizedOperation|Encoded authorization failure message|not authorized to perform|is forbidden|Forbidden|refused by the read-only wrapper/;

/** The tiny stack terraform's probes plan and apply: one SSM parameter, made by nothing else. */
const STACK = `mkdir -p "$HOME/tf" && cd "$HOME/tf"
cat > main.tf <<'TF'
terraform {
  required_providers {
    aws = { source = "hashicorp/aws" }
  }
}
resource "aws_ssm_parameter" "hopper_read_only_check" {
  name  = "/hopper/read-only-check"
  type  = "String"
  value = "hopper"
}
TF
[ -d .terraform ] || "$HOPPER_TOOLS/terraform" init -input=false -no-color >/dev/null`;

/**
 * The stack again, in a directory of its own, with a state that holds its parameter: `destroy` past the wrapper deletes
 * what the state holds. The parameter need not exist. With no refresh, terraform does not first read it from the
 * account, so the delete reaches the account, which must refuse it. Allowed, the provider deletes it, or finds nothing
 * to delete and ends without an error: either way the probe fails.
 */
const HELD = `${STACK}
mkdir -p "$HOME/tf-held" && cp main.tf "$HOME/tf-held/" && cd "$HOME/tf-held" || exit 1
cat > terraform.tfstate <<'STATE'
{"version":4,"terraform_version":"1.0.0","serial":1,"lineage":"hopper-read-only-check","outputs":{},"resources":[{"mode":"managed","type":"aws_ssm_parameter","name":"hopper_read_only_check","provider":"provider[\\"registry.terraform.io/hashicorp/aws\\"]","instances":[{"schema_version":0,"attributes":{"id":"/hopper/read-only-check","name":"/hopper/read-only-check","type":"String","value":"hopper"}}]}]}
STATE
[ -d .terraform ] || "$HOPPER_TOOLS/terraform" init -input=false -no-color >/dev/null`;

/** The terraform writes the read-only wrapper refuses (issue #715): id, what it tries, and the command. */
const WRAPPED: readonly (readonly [string, string, string])[] = [
  ['destroy', 'destroy the stack', 'destroy -auto-approve -input=false -lock=false -no-color'],
  ['import', 'import a resource into state', 'import -input=false -lock=false -no-color aws_ssm_parameter.hopper_read_only_check /hopper/read-only-check'],
  ['state-rm', 'remove a resource from state', 'state rm -lock=false aws_ssm_parameter.hopper_read_only_check'],
  ['state-mv', 'move a resource in state', 'state mv -lock=false aws_ssm_parameter.hopper_read_only_check aws_ssm_parameter.moved'],
  ['state-push', 'push a state file', 'state push -lock=false terraform.tfstate'],
  ['taint', 'taint a resource', 'taint -lock=false aws_ssm_parameter.hopper_read_only_check'],
  ['force-unlock', 'break a state lock', 'force-unlock -force hopper-read-only-check'],
  ['workspace-new', 'make a workspace', 'workspace new -lock=false hopper-read-only-check'],
  ['workspace-delete', 'delete a workspace', 'workspace delete -lock=false hopper-read-only-check'],
];

/**
 * Why `helm.list` can be refused on a view role (issue #869): helm keeps each release in a Secret, so listing releases
 * reads secrets, which the built-in `view` role does not grant. A Forbidden on secrets is expected for such a credential,
 * and passes the probe (issue #1736, `HELM_LIST_REFUSAL`).
 */
export const HELM_LIST_NOTE = 'helm list reads the secrets helm keeps its releases in. A view role cannot read secrets, so a Forbidden on secrets here is expected on such a credential, and the probe passes';

/** The refusal of `helm list` on a view role: secrets, and nothing else, are forbidden (issue #1736). */
export const HELM_LIST_REFUSAL = /\bsecrets is forbidden: .*cannot list resource "secrets"/;

const AWS = ['aws-account', 'aws-role'] as const;
const KUBE = ['cluster', 'namespace'] as const;
/** A kube probe that runs under an observe need too (issue #2146, part 5): its credential must change nothing either. */
const READ_OBSERVE = ['read', 'observe'] as const;
/** The namespace a probe on a `namespace` asset acts in; a cluster's probes act in `default`. */
const NS = 'ns=default; case "$ASSET" in */*) ns="${ASSET#*/}" ;; esac';

/**
 * The host the egress probes try to reach (issue #849): one no read-only box needs, and that answers whenever it is
 * reached. The probe sends it no credential.
 */
export const EGRESS_PROBE_URL = 'https://example.com';
/** The variables a request sent past the egress proxy is made without. */
const NO_PROXY_VARS = '-u HTTPS_PROXY -u https_proxy -u HTTP_PROXY -u http_proxy -u ALL_PROXY -u all_proxy';
/** The words of a request the egress refused: the probe prints them only when the request failed both ways. */
export const EGRESS_DENIAL = /egress refused/;

/**
 * An egress probe (issue #849): the tool sends one request to a host that is not on the allowlist, past the egress proxy
 * (its variables unset, as a process in the box can do) and through it. Each must fail to connect: `blocked` matches the
 * tool's words for that. A request that got an answer of any kind reached the host, and the probe fails.
 */
function egressProbe(request: string, blocked: string): string {
  return `blocked() { case "$1" in ${blocked}) return 0 ;; esac; return 1; }
past=$(env ${NO_PROXY_VARS} ${request} 2>&1); a=$?
via=$(${request} 2>&1); b=$?
printf 'past the proxy (exit %s): %s\\nthrough the proxy (exit %s): %s\\n' "$a" "$past" "$b" "$via"
if [ "$a" -ne 0 ] && blocked "$past" && [ "$b" -ne 0 ] && blocked "$via"; then echo 'egress refused: ${EGRESS_PROBE_URL} is not on the allowlist'; exit 1; fi
exit 0`;
}

/**
 * The egress probes (issue #849): once per check, with the box's AWS CLI or kubectl. Neither request carries a credential
 * of the check: the AWS CLI signs with a fixed key and reads no profile, kubectl sends a fixed token.
 */
export const EGRESS_PROBES: readonly Probe[] = [
  {
    id: 'egress.aws', title: `reach ${EGRESS_PROBE_URL}, not on the allowlist, past the egress proxy and through it (aws)`, kinds: [...AWS, 'terraform-workspace'], tool: 'aws', expect: 'denied', once: true,
    denial: EGRESS_DENIAL,
    script: egressProbe(
      `env -u AWS_SESSION_TOKEN -u AWS_PROFILE -u AWS_ENDPOINT_URL -u AWS_ENDPOINT_URL_STS AWS_ACCESS_KEY_ID=hopper-egress-probe AWS_SECRET_ACCESS_KEY=hopper-egress-probe AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null AWS_REGION=us-east-1 aws --cli-connect-timeout 10 --cli-read-timeout 10 --endpoint-url ${EGRESS_PROBE_URL} sts get-caller-identity`,
      `*'Could not connect to the endpoint URL'*|*'Failed to connect to proxy URL'*|*'Connect timeout on endpoint URL'*`,
    ),
  },
  {
    id: 'egress.kube', title: `reach ${EGRESS_PROBE_URL}, not on the allowlist, past the egress proxy and through it (kubectl)`, kinds: [...KUBE, 'argocd-app'], tool: 'kubectl', expect: 'denied', once: true, operations: READ_OBSERVE,
    denial: EGRESS_DENIAL,
    script: egressProbe(
      `kubectl --kubeconfig=/dev/null --server=${EGRESS_PROBE_URL} --token=hopper-egress-probe --insecure-skip-tls-verify --request-timeout=10s get --raw /`,
      `*'Unable to connect to the server'*`,
    ),
  },
];

/** The line of a probe both of whose requests were refused (issue #2396): its `denial`, so one Forbidden is no refusal. */
export const BOTH_REFUSED = /^both refused: /m;

/**
 * A probe that tries two requests (issue #2146, part 5): it is refused only when both are, each with a Forbidden. It is
 * allowed only on a positive answer (issue #2396): one request went through, or answered NotFound, which the API answers
 * only after it allowed the request. Any other answer (Unauthorized, no connection) is an error: it proves nothing.
 */
function bothRefused(setup: string, first: string, second: string, what: string): string {
  return `${NS}
${setup}
forbidden() { case "$1" in *Forbidden*|*forbidden*) return 0 ;; esac; return 1; }
allowed() { [ "$1" -eq 0 ] && return 0; case "$2" in *NotFound*) return 0 ;; esac; return 1; }
a=$(${first} 2>&1); ca=$?
b=$(${second} 2>&1); cb=$?
printf '%s (exit %s): %s\\n%s (exit %s): %s\\n' '${first}' "$ca" "$a" '${second}' "$cb" "$b"
if allowed "$ca" "$a" || allowed "$cb" "$b"; then exit 0; fi
if forbidden "$a" && forbidden "$b"; then echo 'both refused: ${what} is forbidden'; exit 1; fi
echo '${what}: neither request was allowed, and not both were refused'; exit 2`;
}

/**
 * A GET of a pod's exec as `kubectl exec` sends it (issue #2477): an upgrade to a WebSocket, by curl, with the kubeconfig's
 * server, token and CA. For an upgrade the API server asks `create` on `pods/exec` too, so a view role that may only `get`
 * it (EKS's AmazonEKSViewPolicy) is refused, as `kubectl exec` is; a server that does not ask it lets that role exec, and
 * the upgrade answers NotFound. A plain GET asks `get` only: it answers NotFound for that role, which runs nothing.
 */
const UPGRADE = `upgrade() {
  command -v curl >/dev/null 2>&1 || { echo "the box's image has no curl"; return 127; }
  kc() { kubectl config view --minify --raw -o "jsonpath={$1}"; }
  srv=$(kc .clusters[0].cluster.server) && tok=$(kc .users[0].user.token) && crt=$(kc '.clusters[0].cluster.certificate-authority-data') || return 1
  (umask 077 && printf 'Authorization: Bearer %s\\n' "$tok" > "$HOME/exec-auth") || return 1
  if [ -n "$crt" ]; then printf '%s' "$crt" | base64 -d > "$HOME/exec-ca" || return 1; fi
  curl -sS --http1.1 --max-time 10 --fail-with-body \${crt:+--cacert "$HOME/exec-ca"} -H "@$HOME/exec-auth" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \\
    -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: aG9wcGVyLXJlYWQtb25seQ==' -H 'Sec-WebSocket-Protocol: v5.channel.k8s.io' "$srv$1"
  c=$?; rm -f "$HOME/exec-auth"; return $c
}`;

export const PROBES: readonly Probe[] = [
  { id: 'aws.caller-identity', title: 'read who the session is', kinds: AWS, tool: 'aws', expect: 'allowed', script: 'aws sts get-caller-identity' },
  {
    // The id stays as it was, so a template's probe marks still name this probe.
    id: 'aws.ec2-create-tags', title: 'make a VPC (a dry run)', kinds: AWS, tool: 'aws', expect: 'denied',
    // A dry run that would work answers DryRunOperation, and fails: that is not a refusal. EC2 looks up each resource a
    // write names before the dry run asks the authorization: a VPC or instance the account does not hold answers NotFound
    // or InvalidID (issues #882, #1903), never a refusal. create-vpc names no resource, so EC2 asks the authorization first.
    script: 'aws ec2 create-vpc --dry-run --cidr-block 10.255.0.0/16',
  },
  {
    id: 'aws.ssm-put-parameter', title: 'write an SSM parameter', kinds: AWS, tool: 'aws', expect: 'denied',
    script: 'aws ssm put-parameter --name /hopper/read-only-check --type String --value hopper --overwrite',
    cleanup: 'aws ssm delete-parameter --name /hopper/read-only-check',
  },
  {
    id: 'aws.iam-create-user', title: 'make an IAM user', kinds: AWS, tool: 'aws', expect: 'denied',
    script: 'aws iam create-user --user-name hopper-read-only-check',
    cleanup: 'aws iam delete-user --user-name hopper-read-only-check',
  },
  {
    id: 'aws.sts-assume-role', title: 'assume another role in the account', kinds: AWS, tool: 'aws', expect: 'denied',
    script: 'account=$(aws sts get-caller-identity --query Account --output text) || exit 1\naws sts assume-role --role-arn "arn:aws:iam::$account:role/hopper-read-only-check-admin" --role-session-name hopper-read-only-check',
  },
  { id: 'kube.get', title: 'list namespaces, or pods in the namespace', kinds: KUBE, tool: 'kubectl', expect: 'allowed', operations: READ_OBSERVE, script: `${NS}\ncase "$ASSET" in */*) kubectl get pods -n "$ns" ;; *) kubectl get ns ;; esac` },
  { id: 'kube.create-namespace', title: 'make a namespace (a server dry run)', kinds: KUBE, tool: 'kubectl', expect: 'denied', operations: READ_OBSERVE, script: 'kubectl create namespace hopper-read-only-check --dry-run=server' },
  {
    id: 'kube.delete-pod', title: 'delete a pod (a server dry run)', kinds: KUBE, tool: 'kubectl', expect: 'denied', operations: READ_OBSERVE,
    // Allowed, it answers NotFound: that is not a refusal.
    script: `${NS}\nkubectl delete pod hopper-read-only-check -n "$ns" --dry-run=server`,
  },
  {
    id: 'helm.list', title: 'list releases', kinds: KUBE, tool: 'helm', expect: 'allowed', note: HELM_LIST_NOTE, rightRefusal: HELM_LIST_REFUSAL,
    script: `${NS}\ncase "$ASSET" in */*) helm list -n "$ns" ;; *) helm list -A ;; esac`,
  },
  {
    // Issue #869: `helm install --dry-run=server` renders the chart and creates nothing, so it never asks the API's
    // authorization for the writes and ends 0 on a view role. The chart helm renders is created with kubectl's server dry
    // run, which asks the authorization of each object. One object created fails the probe, even when others are refused.
    id: 'helm.install', title: 'install a chart (its objects, a server dry run)', kinds: KUBE, tool: 'helm', expect: 'denied',
    script: `${NS}
cd "$HOME" && { [ -d chart ] || helm create chart >/dev/null; } || exit 1
helm template hopper-read-only-check ./chart -n "$ns" > chart.yaml || exit 1
out=$(kubectl create -n "$ns" --dry-run=server -f chart.yaml 2>&1); code=$?
printf '%s\\n' "$out"
case "$out" in *'(server dry run)'*) exit 0 ;; esac
exit "$code"`,
  },
  // Issue #2146, part 5: an observe credential may port-forward to the monitoring pods, and nothing more. It must not
  // run a command in a pod, nor read a Secret.
  {
    id: 'observe.exec', title: 'run a command in a pod (pods/exec, by its create and its get as a WebSocket upgrade)', kinds: KUBE, tool: 'kubectl', expect: 'denied', operations: ['observe'],
    // The API asks the authorization before it looks for the pod: allowed, each answers NotFound, which is no refusal.
    script: bothRefused(`path="/api/v1/namespaces/$ns/pods/hopper-read-only-check/exec?command=true&stdout=true"\n${UPGRADE}`,
      'kubectl create --raw "$path" -f /dev/null', 'upgrade "$path"', 'pods/exec'),
    denial: BOTH_REFUSED,
  },
  {
    id: 'observe.secret-read', title: 'read Secrets (a list, and a get of one)', kinds: KUBE, tool: 'kubectl', expect: 'denied', operations: ['observe'],
    script: bothRefused('scope="-A"; case "$ASSET" in */*) scope="-n $ns" ;; esac',
      'kubectl get secrets $scope', 'kubectl get secret hopper-read-only-check -n "$ns"', 'secrets'),
    denial: BOTH_REFUSED,
  },
  { id: 'argocd.get', title: 'read the application', kinds: ['argocd-app'], tool: 'kubectl', expect: 'allowed', script: 'kubectl get applications.argoproj.io "$ASSET" -n argocd' },
  {
    id: 'argocd.patch', title: 'change the application (a server dry run)', kinds: ['argocd-app'], tool: 'kubectl', expect: 'denied',
    script: 'kubectl patch applications.argoproj.io "$ASSET" -n argocd --type merge -p \'{"metadata":{"labels":{"hopper-read-only-check":"1"}}}\' --dry-run=server',
  },
  { id: 'terraform.plan', title: 'plan a one-resource stack', kinds: ['terraform-workspace'], tool: 'terraform', expect: 'allowed', script: `${STACK}\nterraform plan -input=false -lock=false -no-color` },
  {
    id: 'terraform.apply', title: 'apply a one-resource stack (terraform on PATH)', kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    script: `${STACK}\nterraform apply -auto-approve -input=false -lock=false -no-color`,
    cleanup: `${STACK}\n"$HOPPER_TOOLS/terraform" destroy -auto-approve -input=false -lock=false -no-color`,
  },
  {
    id: 'terraform.apply-direct', title: 'apply a one-resource stack (the real binary, past any wrapper)', kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    script: `${STACK}\n"$HOPPER_TOOLS/terraform" apply -auto-approve -input=false -lock=false -no-color`,
    cleanup: `${STACK}\n"$HOPPER_TOOLS/terraform" destroy -auto-approve -input=false -lock=false -no-color`,
  },
  {
    // Issue #715: destroy past the wrapper is refused by the account too, as apply is.
    id: 'terraform.destroy-direct', title: 'destroy a parameter held in state (the real binary, past any wrapper)', kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    script: `${HELD}\n"$HOPPER_TOOLS/terraform" destroy -auto-approve -input=false -lock=false -refresh=false -no-color`,
  },
  {
    // Issue #715, part 6: a state write past the wrapper is refused by the account. A state of the check's own, pushed to
    // the check's own key in the workspace's bucket (never the workspace's state): init only reads the bucket, and the
    // push is the one write. Allowed, the cleanup deletes that key, and the probe fails. Not run with no backend.
    id: 'terraform.state-push-direct', title: 'push a state to the check\'s own key in the workspace\'s bucket (the real binary, past any wrapper)', kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    backend: true, denial: /PutObject[\s\S]*(AccessDenied|not authorized)/,
    script: `mkdir -p "$HOME/tf-backend" && cd "$HOME/tf-backend" && rm -rf .terraform || exit 1
cat > main.tf <<'TF'
terraform {
  backend "s3" {}
}
TF
cat > probe.tfstate <<'STATE'
{"version":4,"terraform_version":"1.0.0","serial":1,"lineage":"hopper-read-only-check","outputs":{},"resources":[]}
STATE
"$HOPPER_TOOLS/terraform" init -input=false -no-color -reconfigure -backend-config="bucket=$HOPPER_STATE_BUCKET" -backend-config="key=$HOPPER_STATE_KEY" -backend-config="region=$HOPPER_STATE_REGION" >/dev/null || exit 1
"$HOPPER_TOOLS/terraform" state push -lock=false probe.tfstate`,
    cleanup: 'aws s3api delete-object --bucket "$HOPPER_STATE_BUCKET" --key "$HOPPER_STATE_KEY" --region "$HOPPER_STATE_REGION"',
  },
  // Issue #715: each state or infrastructure write terraform has, on PATH, is refused by the read-only wrapper before it
  // reaches the account or the state. Past the wrapper, `apply-direct` and `destroy-direct` above show the account refuses on its own.
  ...WRAPPED.map(([id, title, command]): Probe => ({
    id: `terraform.${id}`, title: `${title} (terraform on PATH)`, kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    script: `${STACK}\nterraform ${command}`,
  })),
  {
    // Issue #715: a read-only image installs providers only from its own mirror, so a provider it does not hold is not
    // downloaded. hashicorp/dns is small, real and not in the mirror (issue #1977 put hashicorp/null there): with a
    // registry in reach, init would install it. A registry the egress proxy filtered (tinyproxy answers `Filtered`) is a
    // refusal too: the download did not happen (issue #2107). A registry out of reach for another reason is an error.
    // Off a terminal terraform wraps its error at 78 columns, so a line break can fall between any two words (issue #2564).
    id: 'terraform.provider-download', title: 'install a provider the image does not hold (terraform on PATH)', kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    denial: /was\s+not\s+found\s+in\s+any\s+of\s+the\s+search\s+locations|refused by the read-only wrapper|could\s+not\s+connect\s+to\s+registry\.terraform\.io:(?:[^\n]|\n(?!\n))*\bFiltered\b/,
    script: `mkdir -p "$HOME/tf-provider" && cd "$HOME/tf-provider" && rm -rf .terraform .terraform.lock.hcl
cat > main.tf <<'TF'
terraform {
  required_providers {
    probe = { source = "hashicorp/dns" }
  }
}
TF
terraform init -input=false -no-color`,
  },
  // Issue #849: a read-only box reaches out only through the egress proxy, to the allowlist.
  ...EGRESS_PROBES,
];

/** A probe that writes to the need's state backend: its environment, or why it is not run (issue #715). */
function backendOf(n: OperationProfile): Pick<ProbeRun, 'vars' | 'notRun'> {
  const b = n.backend;
  if (!b) return { notRun: `not run: no backend configured. A person sets the state backend of ${n.asset.kind} ${n.asset.name} (its bucket, region and key prefix) in Vault` };
  return { vars: { HOPPER_STATE_BUCKET: b.bucket, HOPPER_STATE_REGION: b.region, HOPPER_STATE_KEY: stateProbeKey(b) } };
}

/** A catalog of these probes: for each read or observe need, every probe of its asset's kind and its operation, once per need. */
export function probeCatalog(probes: readonly Probe[]): ProbeCatalog {
  return {
    runsFor(needs: readonly OperationProfile[]): ProbeRun[] {
      const seen = new Set<string>();
      return needs.flatMap((n) => probes.filter((p) => p.kinds.includes(n.asset.kind) && (p.operations ?? ['read']).some((op) => op === n.operation)).flatMap((probe) => {
        const key = probe.once ? probe.id : `${probe.id} ${n.operation} ${n.asset.kind} ${n.asset.name}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ probe, kind: n.asset.kind, asset: n.asset.name, ...(n.operation === 'observe' ? { operation: 'observe' as const } : {}), ...(probe.backend ? backendOf(n) : {}) }];
      }));
    },
  };
}

/** The hopper's own catalog. */
export const HOPPER_PROBES = probeCatalog(PROBES);
