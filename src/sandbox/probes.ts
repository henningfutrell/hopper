// The hopper's probes for the read-only check (issue #716, item 4; design.md "The read-only check"): for each asset kind,
// the writes that must be refused and the reads that must work, after the negative suite issue #715 asks for. Each write
// is one that leaves nothing when it is refused, and a dry run where the service has one (EC2 `--dry-run`, Kubernetes
// `--dry-run=server`): a server dry run still asks the API's authorization. A write that goes through is undone by its
// `cleanup`, and the check fails. The catalog is data: issue #715 added the terraform wrapper's probes here.
import type { OperationProfile } from '../domain/access.ts';
import type { Probe, ProbeCatalog, ProbeRun } from '../domain/read-only-check.ts';

/** The words of a refusal from AWS, Kubernetes, helm, terraform, or a read-only wrapper on PATH. */
export const DENIAL = /AccessDenied|UnauthorizedOperation|not authorized to perform|is forbidden|Forbidden|refused by the read-only wrapper/;

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

const AWS = ['aws-account', 'aws-role'] as const;
const KUBE = ['cluster', 'namespace'] as const;
/** The namespace a probe on a `namespace` asset acts in; a cluster's probes act in `default`. */
const NS = 'ns=default; case "$ASSET" in */*) ns="${ASSET#*/}" ;; esac';

export const PROBES: readonly Probe[] = [
  { id: 'aws.caller-identity', title: 'read who the session is', kinds: AWS, tool: 'aws', expect: 'allowed', script: 'aws sts get-caller-identity' },
  {
    id: 'aws.ec2-create-tags', title: 'tag a VPC (a dry run)', kinds: AWS, tool: 'aws', expect: 'denied',
    // A dry run that would work answers DryRunOperation, and fails: that is not a refusal.
    script: 'aws ec2 create-tags --dry-run --resources vpc-00000000 --tags Key=hopper-read-only-check,Value=1',
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
  { id: 'kube.get', title: 'list namespaces, or pods in the namespace', kinds: KUBE, tool: 'kubectl', expect: 'allowed', script: `${NS}\ncase "$ASSET" in */*) kubectl get pods -n "$ns" ;; *) kubectl get ns ;; esac` },
  { id: 'kube.create-namespace', title: 'make a namespace (a server dry run)', kinds: KUBE, tool: 'kubectl', expect: 'denied', script: 'kubectl create namespace hopper-read-only-check --dry-run=server' },
  {
    id: 'kube.delete-pod', title: 'delete a pod (a server dry run)', kinds: KUBE, tool: 'kubectl', expect: 'denied',
    // Allowed, it answers NotFound: that is not a refusal.
    script: `${NS}\nkubectl delete pod hopper-read-only-check -n "$ns" --dry-run=server`,
  },
  { id: 'helm.list', title: 'list releases', kinds: KUBE, tool: 'helm', expect: 'allowed', script: `${NS}\ncase "$ASSET" in */*) helm list -n "$ns" ;; *) helm list -A ;; esac` },
  {
    id: 'helm.install', title: 'install a chart (a server dry run)', kinds: KUBE, tool: 'helm', expect: 'denied',
    script: `${NS}\ncd "$HOME" && { [ -d chart ] || helm create chart >/dev/null; } || exit 1\nhelm install hopper-read-only-check ./chart -n "$ns" --dry-run=server`,
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
  // Issue #715: each state or infrastructure write terraform has, on PATH, is refused by the read-only wrapper before it
  // reaches the account or the state. Past the wrapper, `apply-direct` above shows the account refuses on its own.
  ...WRAPPED.map(([id, title, command]): Probe => ({
    id: `terraform.${id}`, title: `${title} (terraform on PATH)`, kinds: ['terraform-workspace'], tool: 'terraform', expect: 'denied',
    script: `${STACK}\nterraform ${command}`,
  })),
];

/** A catalog of these probes: for each read need, every probe of its asset's kind, once per asset. */
export function probeCatalog(probes: readonly Probe[]): ProbeCatalog {
  return {
    runsFor(needs: readonly OperationProfile[]): ProbeRun[] {
      const seen = new Set<string>();
      return needs.flatMap((n) => probes.filter((p) => p.kinds.includes(n.asset.kind)).flatMap((probe) => {
        const key = `${probe.id} ${n.asset.kind} ${n.asset.name}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ probe, kind: n.asset.kind, asset: n.asset.name }];
      }));
    },
  };
}

/** The hopper's own catalog. */
export const HOPPER_PROBES = probeCatalog(PROBES);
