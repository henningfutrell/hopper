// Fake aws, kubectl, helm and terraform (issue #716, the read-only check): shell scripts in a temp dir that answer as the
// real tools do under a read-only credential (every write refused, in each tool's own words) or a writable one (every
// write goes through). Each call is logged to `calls`, so a test sees a cleanup run. `runScript` runs a check box's script
// with them as its tools and the box's environment, as the container runtime double's one-shot containers do.
// `credentials` (issue #797): aws (and terraform, issue #715) then answers only with that minted session in its environment, and kubectl and helm only
// with a kubeconfig that holds that token — else each fails as the real tool does with no credential.
// Issue #715: the read-only terraform wrapper is first on PATH, as in a read-only template's image, with the fake
// terraform as the real binary in HOPPER_TOOLS behind it; `wrapper: false` leaves it out. With the wrapper, the image's
// provider mirror is there too: TF_CLI_CONFIG_FILE names it, and init finds only the providers it holds (`MIRRORED_PROVIDERS`), as the real terraform does.
// After an init with -backend-config (an S3 backend), a state push writes to the bucket: refused under a read-only credential.
// Issue #2146, part 5: kubectl refuses a Secret read and an exec under a read-only credential.
// Issue #2477: a fake curl answers a WebSocket upgrade of a pod's exec as the API server does, and kubectl's config view
// gives the kubeconfig's server and token.
// Issue #849: aws and kubectl sent to a host off the allowlist (the egress probes) answer as the real tools do. `limited`
// (the default): it cannot be reached, past the proxy or through it; `open`: it is reached either way; `proxy-open`: the
// proxy lets it through, but the box has no route of its own.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ContainerSpec } from '../../src/domain/ports.ts';
import { TERRAFORM_CLI_CONFIG, TERRAFORM_WRAPPER } from '../../src/sandbox/terraform-wrapper.ts';
import { MIRRORED_PROVIDERS } from '../../src/sandbox/tools.ts';

/**
 * `unauthorized` (issue #2396): kubectl's every request is refused as the API server refuses a token it does not take, as
 * before an EKS access entry holds it; `get-unauthorized`: only its gets are, its other requests answer as `read-only`.
 */
/**
 * `view-exec` (issue #2477): a view role that may get `pods/exec` but not create it, as EKS's AmazonEKSViewPolicy gives: a
 * plain GET of exec answers NotFound, and a WebSocket upgrade, for which the API server asks create too, is Forbidden.
 */
export type CloudMode = 'read-only' | 'writable' | 'unauthorized' | 'get-unauthorized' | 'view-exec';
/** What a box's egress lets out (issue #849). */
export type EgressMode = 'limited' | 'open' | 'proxy-open';

/** The egress probes' requests (issue #849), before any credential check: each one goes to a host off the allowlist. */
const EGRESS: Record<string, string> = {
  aws: `case " $* " in *" --endpoint-url https://example.com "*)
  case "$EGRESS" in open) reached=1 ;; proxy-open) [ -n "\${HTTPS_PROXY:-}" ] && reached=1 ;; esac
  if [ -n "\${reached:-}" ]; then echo 'aws: [ERROR]: Unable to parse response (syntax error: line 1, column 0), invalid XML received.' >&2; exit 255; fi
  if [ -n "\${HTTPS_PROXY:-}" ]; then echo "aws: [ERROR]: Failed to connect to proxy URL: \\"$HTTPS_PROXY\\"" >&2; else echo 'aws: [ERROR]: Could not connect to the endpoint URL: "https://example.com/"' >&2; fi
  exit 255 ;;
esac`,
  kubectl: `case " $* " in *" --server=https://example.com "*)
  case "$EGRESS" in open) reached=1 ;; proxy-open) [ -n "\${HTTPS_PROXY:-}" ] && reached=1 ;; esac
  if [ -n "\${reached:-}" ]; then echo '<!doctype html><title>Example Domain</title>'; exit 0; fi
  if [ -n "\${HTTPS_PROXY:-}" ]; then echo 'Unable to connect to the server: Filtered' >&2; else echo 'Unable to connect to the server: dial tcp: lookup example.com: no such host' >&2; fi
  exit 1 ;;
esac`,
};

/** The minted credentials the tools take: an AWS session token, a Kubernetes token. */
export interface FakeCredentials { awsSessionToken: string; kubeToken: string }

const AWS_CREDENTIAL = `[ "$AWS_SESSION_TOKEN" = "$AWS_WANTS" ] && [ -n "$AWS_ACCESS_KEY_ID" ] || { echo 'Unable to locate credentials. You can configure credentials by running "aws configure".' >&2; exit 253; }`;
const KUBE_CREDENTIAL = `[ -n "$KUBECONFIG" ] && grep -q "$KUBE_WANTS" "$KUBECONFIG" 2>/dev/null || { echo 'The connection to the server localhost:8080 was refused - did you specify the right host or port?' >&2; exit 1; }`;
// terraform's AWS provider and S3 backend read the same AWS CLI variables (issue #715).
const CHECKS: Record<string, string> = { aws: AWS_CREDENTIAL, terraform: AWS_CREDENTIAL, kubectl: KUBE_CREDENTIAL, helm: KUBE_CREDENTIAL };

const TOOLS: Record<string, string> = {
  aws: `case "$*" in
  *"get-caller-identity --query Account"*) echo 123456789012 ;;
  *get-caller-identity*) echo '{"Account":"123456789012","Arn":"arn:aws:sts::123456789012:assumed-role/hopper-read/s"}' ;;
  *"--dry-run"*) if [ "$MODE" = read-only ]; then echo 'An error occurred (UnauthorizedOperation) when calling the CreateVpc operation: You are not authorized to perform this operation.' >&2; else echo 'An error occurred (DryRunOperation) when calling the CreateVpc operation: Request would have succeeded, but DryRun flag is set.' >&2; fi; exit 254 ;;
  *delete-*) exit 0 ;;
  *) if [ "$MODE" = read-only ]; then echo "An error occurred (AccessDenied) when calling the operation: User is not authorized to perform: $2:$3" >&2; exit 254; fi ;;
esac`,
  kubectl: `case "$1" in config) case "$*" in
    *server*) sed -n 's/.*"server":"\\([^"]*\\)".*/\\1/p' "$KUBECONFIG" ;;
    *token*) sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' "$KUBECONFIG" ;;
  esac; exit 0 ;; esac
case "$MODE:$1" in unauthorized:*|get-unauthorized:get) echo 'error: You must be logged in to the server (Unauthorized)' >&2; exit 1 ;; get-unauthorized:*) MODE=read-only ;;
  view-exec:get) case " $* " in *"/exec"*) echo 'Error from server (NotFound): pods "hopper-read-only-check" not found' >&2; exit 1 ;; esac; MODE=read-only ;;
  view-exec:*) MODE=read-only ;;
esac
case "$1" in
  # A view role reads no Secret and runs nothing in a pod (issue #2146, part 5). Allowed, the exec answers NotFound.
  get) case " $* " in *" secret"*|*"/exec"*)
      if [ "$MODE" = read-only ]; then echo "Error from server (Forbidden): $2 is forbidden: User \\"system:serviceaccount:hopper:hopper\\" cannot get" >&2; exit 1; fi
      case " $* " in *"/exec"*) echo 'Error from server (NotFound): pods "hopper-read-only-check" not found' >&2; exit 1 ;; esac ;;
    esac
    echo 'NAME STATUS' ;;
  *) if [ "$MODE" = read-only ]; then echo "Error from server (Forbidden): $2 is forbidden: User \\"system:serviceaccount:hopper:hopper\\" cannot $1" >&2; exit 1; fi
     [ "$1" = delete ] && { echo 'Error from server (NotFound): pods "hopper-read-only-check" not found' >&2; exit 1; }
     [ "$1" = create ] && case " $* " in *" --dry-run=server "*) echo 'deployment.apps/hopper-read-only-check-chart created (server dry run)' ;; esac ;;
esac`,
  // Only a WebSocket upgrade of a pod's exec, with a bearer token from its header file (issue #2477).
  curl: `auth=; for a in "$@"; do case "$a" in @*) auth=$(cat "\${a#@}") ;; esac; done
case "$*" in *"Upgrade: websocket"*"/exec?"*) ;; *) echo 'curl: (6) Could not resolve host' >&2; exit 6 ;; esac
case "$MODE:$auth" in
  unauthorized:*|get-unauthorized:*|*:) echo '{"kind":"Status","status":"Failure","message":"Unauthorized","reason":"Unauthorized","code":401}'; echo 'curl: (22) The requested URL returned error: 401' >&2; exit 22 ;;
  writable:*) echo '{"kind":"Status","status":"Failure","message":"pods \\"hopper-read-only-check\\" not found","reason":"NotFound","code":404}'; echo 'curl: (22) The requested URL returned error: 404' >&2; exit 22 ;;
esac
echo '{"kind":"Status","status":"Failure","message":"pods \\"hopper-read-only-check\\" is forbidden: User \\"system:serviceaccount:hopper:hopper\\" cannot create resource \\"pods/exec\\" in API group \\"\\" in the namespace","reason":"Forbidden","code":403}'
echo 'curl: (22) The requested URL returned error: 403' >&2; exit 22`,
  // helm's `--dry-run=server` renders the chart and creates nothing: it never asks the API's authorization for the
  // writes, so it ends 0 under a read-only credential too (issue #869). `template` renders the chart.
  helm: `case "$1" in
  list) echo 'NAME NAMESPACE' ;;
  create) mkdir -p "$2" ;;
  install) case " $* " in *" --dry-run=server "*) echo 'NAME: hopper-read-only-check'; echo 'STATUS: pending-install' ;;
    *) if [ "$MODE" = read-only ]; then echo 'Error: INSTALLATION FAILED: secrets is forbidden: User cannot create resource' >&2; exit 1; fi ;;
    esac ;;
  template) printf '%s\\n' '---' 'apiVersion: apps/v1' 'kind: Deployment' 'metadata:' '  name: hopper-read-only-check-chart' ;;
esac`,
  terraform: `case "$1" in
  init) if [ -f "\${TF_CLI_CONFIG_FILE:-}" ]; then
      for s in $(sed -n 's/.*source *= *"\\([^"]*\\)".*/\\1/p' *.tf); do
        [ -d "$(dirname "$TF_CLI_CONFIG_FILE")/providers/registry.terraform.io/$s" ] || { echo "Error: Failed to query available provider packages: provider registry.terraform.io/$s was not found in any of the search locations" >&2; exit 1; }
      done
    fi
    mkdir -p .terraform
    # An S3 backend (issue #715): init with -backend-config keeps it, and a state push then writes to the bucket.
    case " $* " in *" -backend-config="*) touch .terraform/s3-backend ;; esac ;;
  plan) echo 'Plan: 1 to add, 0 to change, 0 to destroy.' ;;
  apply) if [ "$MODE" = read-only ]; then echo 'Error: creating SSM Parameter: AccessDeniedException: User is not authorized to perform: ssm:PutParameter' >&2; exit 1; fi ;;
  destroy) case " $* " in
    # With no refresh, each resource its state holds is deleted. A refresh first finds the account holds no parameter.
    *" -refresh=false "*) if grep -q '"aws_ssm_parameter"' terraform.tfstate 2>/dev/null; then
        if [ "$MODE" = read-only ]; then echo 'Error: deleting SSM Parameter (/hopper/read-only-check): AccessDeniedException: User is not authorized to perform: ssm:DeleteParameter with an explicit deny in a session policy' >&2; exit 1; fi
        echo 'Destroy complete! Resources: 1 destroyed.'; exit 0
      fi ;;
    esac
    echo 'No changes. No objects need to be destroyed.' ;;
  state) if [ "$2" = push ] && [ -f .terraform/s3-backend ] && [ "$MODE" = read-only ]; then
      echo 'Failed to persist state: failed to upload state: operation error S3: PutObject, https response error StatusCode: 403, RequestID: 1, HostID: , api error AccessDenied: User: arn:aws:sts::123456789012:assumed-role/hopper-read/s is not authorized to perform: s3:PutObject with an explicit deny in a session policy' >&2; exit 1
    fi ;;
esac`,
};

export interface FakeCloudTools {
  dir: string;
  /** Every call, one per line: `<tool> <args>`. */
  calls(): string[];
  setMode(mode: CloudMode): void;
  /** What a box's egress lets out (issue #849); `limited` until set. */
  setEgress(egress: EgressMode): void;
  runScript(spec: ContainerSpec): Promise<{ exit: number; output: string }>;
  cleanup(): void;
}

export function createFakeCloudTools(mode: CloudMode = 'read-only', credentials?: FakeCredentials, o: { wrapper?: boolean } = {}): FakeCloudTools {
  const dir = mkdtempSync(join(tmpdir(), 'fake-cloud-'));
  const wrapper = o.wrapper ?? true;
  if (wrapper) {
    mkdirSync(join(dir, 'read-only'));
    writeFileSync(join(dir, 'read-only', 'terraform'), TERRAFORM_WRAPPER);
    chmodSync(join(dir, 'read-only', 'terraform'), 0o755);
    writeFileSync(join(dir, 'terraform.rc'), TERRAFORM_CLI_CONFIG);
    for (const source of MIRRORED_PROVIDERS) mkdirSync(join(dir, 'providers', 'registry.terraform.io', source), { recursive: true });
  }
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const setMode = (m: CloudMode): void => writeFileSync(join(dir, 'mode'), m);
  setMode(mode);
  const setEgress = (e: EgressMode): void => writeFileSync(join(dir, 'egress'), e);
  setEgress('limited');
  for (const [tool, body] of Object.entries(TOOLS)) {
    const path = join(dir, tool);
    const check = credentials && CHECKS[tool] ? `AWS_WANTS=${credentials.awsSessionToken} KUBE_WANTS=${credentials.kubeToken}\n${CHECKS[tool]}\n` : '';
    const egress = EGRESS[tool] ? `EGRESS=$(cat ${JSON.stringify(join(dir, 'egress'))})\n${EGRESS[tool]}\n` : '';
    writeFileSync(path, `#!/bin/sh\nMODE=$(cat ${JSON.stringify(join(dir, 'mode'))})\necho "${tool} $*" >> ${JSON.stringify(log)}\n${egress}${check}${body}\nexit 0\n`);
    chmodSync(path, 0o755);
  }
  return {
    dir, setMode, setEgress,
    calls: () => readFileSync(log, 'utf8').split('\n').filter((x) => x !== ''),
    runScript: (spec) => new Promise((resolve) => {
      const home = mkdtempSync(join(dir, 'box-'));
      // The tools first, then node's and the system's: the check needs sh, coreutils and base64 as a box has them.
      const tools = wrapper ? `${join(dir, 'read-only')}:${dir}` : dir;
      const env = { ...spec.env, PATH: `${tools}:${dirname(process.execPath)}:/usr/bin:/bin`, HOPPER_TOOLS: dir, HOPPER_CHECK_DIR: home, ...(wrapper ? { TF_CLI_CONFIG_FILE: join(dir, 'terraform.rc') } : {}) };
      execFile('sh', ['-c', spec.script ?? ''], { env, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ exit: err ? Number((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr });
      });
    }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
