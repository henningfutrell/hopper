// Fake aws, kubectl, helm and terraform (issue #716, the read-only check): shell scripts in a temp dir that answer as the
// real tools do under a read-only credential (every write refused, in each tool's own words) or a writable one (every
// write goes through). Each call is logged to `calls`, so a test sees a cleanup run. `runScript` runs a check box's script
// with them as its tools and the box's environment, as the container runtime double's one-shot containers do.
// `credentials` (issue #797): aws (and terraform, issue #715) then answers only with that minted session in its environment, and kubectl and helm only
// with a kubeconfig that holds that token — else each fails as the real tool does with no credential.
// Issue #715: the read-only terraform wrapper is first on PATH, as in a read-only template's image, with the fake
// terraform as the real binary in HOPPER_TOOLS behind it; `wrapper: false` leaves it out. With the wrapper, the image's
// provider mirror is there too: TF_CLI_CONFIG_FILE names it, and init finds only hashicorp/aws, as the real terraform does.
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ContainerSpec } from '../../src/domain/ports.ts';
import { TERRAFORM_CLI_CONFIG, TERRAFORM_WRAPPER } from '../../src/sandbox/terraform-wrapper.ts';

export type CloudMode = 'read-only' | 'writable';

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
  *"--dry-run"*) if [ "$MODE" = read-only ]; then echo 'An error occurred (UnauthorizedOperation) when calling the CreateTags operation: You are not authorized to perform this operation.' >&2; else echo 'An error occurred (DryRunOperation) when calling the CreateTags operation: Request would have succeeded, but DryRun flag is set.' >&2; fi; exit 254 ;;
  *delete-*) exit 0 ;;
  *) if [ "$MODE" = read-only ]; then echo "An error occurred (AccessDenied) when calling the operation: User is not authorized to perform: $2:$3" >&2; exit 254; fi ;;
esac`,
  kubectl: `case "$1" in
  get) echo 'NAME STATUS' ;;
  *) if [ "$MODE" = read-only ]; then echo "Error from server (Forbidden): $2 is forbidden: User \\"system:serviceaccount:hopper:hopper\\" cannot $1" >&2; exit 1; fi
     [ "$1" = delete ] && { echo 'Error from server (NotFound): pods "hopper-read-only-check" not found' >&2; exit 1; } ;;
esac`,
  helm: `case "$1" in
  list) echo 'NAME NAMESPACE' ;;
  create) mkdir -p "$2" ;;
  install) if [ "$MODE" = read-only ]; then echo 'Error: INSTALLATION FAILED: secrets is forbidden: User cannot create resource' >&2; exit 1; fi ;;
esac`,
  terraform: `case "$1" in
  init) if [ -f "\${TF_CLI_CONFIG_FILE:-}" ]; then
      for s in $(sed -n 's/.*source *= *"\\([^"]*\\)".*/\\1/p' *.tf); do
        [ -d "$(dirname "$TF_CLI_CONFIG_FILE")/providers/registry.terraform.io/$s" ] || { echo "Error: Failed to query available provider packages: provider registry.terraform.io/$s was not found in any of the search locations" >&2; exit 1; }
      done
    fi
    mkdir -p .terraform ;;
  plan) echo 'Plan: 1 to add, 0 to change, 0 to destroy.' ;;
  apply) if [ "$MODE" = read-only ]; then echo 'Error: creating SSM Parameter: AccessDeniedException: User is not authorized to perform: ssm:PutParameter' >&2; exit 1; fi ;;
esac`,
};

export interface FakeCloudTools {
  dir: string;
  /** Every call, one per line: `<tool> <args>`. */
  calls(): string[];
  setMode(mode: CloudMode): void;
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
    mkdirSync(join(dir, 'providers', 'registry.terraform.io', 'hashicorp', 'aws'), { recursive: true });
  }
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const setMode = (m: CloudMode): void => writeFileSync(join(dir, 'mode'), m);
  setMode(mode);
  for (const [tool, body] of Object.entries(TOOLS)) {
    const path = join(dir, tool);
    const check = credentials && CHECKS[tool] ? `AWS_WANTS=${credentials.awsSessionToken} KUBE_WANTS=${credentials.kubeToken}\n${CHECKS[tool]}\n` : '';
    writeFileSync(path, `#!/bin/sh\nMODE=$(cat ${JSON.stringify(join(dir, 'mode'))})\necho "${tool} $*" >> ${JSON.stringify(log)}\n${check}${body}\nexit 0\n`);
    chmodSync(path, 0o755);
  }
  return {
    dir, setMode,
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
