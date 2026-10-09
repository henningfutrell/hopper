// Discovery (issue #542, design.md "Blast radius and actor machines"): what a machine holds, read by a fixed POSIX sh
// script run through the machine's own connection — this machine, ssh, or a client target's `/discover` — never typed
// into a pane. It lists the PATH and its executables, the known tools' versions (aws, terraform, tofu, kubectl), every
// AWS profile's identity and what IAM policy simulation allows it of a curated list of actions, every kubectl
// context and what `auth can-i` says of a curated list of checks across all namespaces, and the credential sources
// present. Only reads: identity, configuration reads, simulation and can-i. Only names: never a variable's value or a
// file's content. Here because a client target runs it, and a client release carries its files.

export const DISCOVER_DONE = 'hopper-discovered';

/** How long a discovery may take: each of its calls is bounded at 10 s. */
export const DISCOVER_TIMEOUT_MS = 120000;

/** The write actions every AWS identity is simulated for: any allowed is write reach. */
export const AWS_WRITE_ACTIONS = [
  's3:PutObject', 's3:DeleteObject', 'ec2:RunInstances', 'ec2:TerminateInstances', 'rds:DeleteDBInstance',
  'eks:UpdateClusterConfig', 'lambda:UpdateFunctionCode', 'dynamodb:DeleteTable', 'cloudformation:DeleteStack',
  'iam:CreateUser', 'iam:AttachRolePolicy', 'iam:PutRolePolicy',
] as const;

/** Of them, the ones that let an identity grant itself more: any allowed is admin. */
export const AWS_ADMIN_ACTIONS = ['iam:CreateUser', 'iam:AttachRolePolicy', 'iam:PutRolePolicy'] as const;

/** What `kubectl auth can-i` is asked in each context, across all namespaces. `* *`: every verb on every resource. */
export const KUBE_CHECKS = ['create deployments', 'delete pods', 'get secrets', '* *'] as const;

/** At most this many AWS profiles and kubectl contexts are asked: each costs calls with a timeout. */
const MAX_PROFILES = 8;
const MAX_CONTEXTS = 8;

/** The names of credential variables reported; their values never are. */
const CREDENTIAL_ENV = '^(AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE|ROLE_ARN|WEB_IDENTITY_TOKEN_FILE|CONTAINER_CREDENTIALS_RELATIVE_URI|CONTAINER_CREDENTIALS_FULL_URI|SHARED_CREDENTIALS_FILE|CONFIG_FILE)|KUBECONFIG|TF_TOKEN_[A-Za-z0-9_]+|TF_WORKSPACE|TF_CLOUD_[A-Z_]+|GOOGLE_APPLICATION_CREDENTIALS|AZURE_[A-Z_]+|ARM_[A-Z_]+|VAULT_TOKEN|VAULT_ADDR|DATABASE_URL|PGPASSWORD)$';

/** Credential files looked for, by label: present or not, never read. */
const CREDENTIAL_FILES: [label: string, test: string][] = [
  ['aws-credentials', '[ -f "$HOME/.aws/credentials" ]'],
  ['aws-config', '[ -f "$HOME/.aws/config" ]'],
  ['aws-web-identity-token', '[ -n "$AWS_WEB_IDENTITY_TOKEN_FILE" ] && [ -f "$AWS_WEB_IDENTITY_TOKEN_FILE" ]'],
  ['kubeconfig', '[ -f "$HOME/.kube/config" ] || { [ -n "$KUBECONFIG" ] && [ -f "${KUBECONFIG%%:*}" ]; }'],
  ['kubernetes-service-account', '[ -f /var/run/secrets/kubernetes.io/serviceaccount/token ]'],
  ['terraform-credentials', '[ -f "$HOME/.terraform.d/credentials.tfrc.json" ]'],
  ['gcloud', '[ -d "$HOME/.config/gcloud" ]'],
  ['azure', '[ -d "$HOME/.azure" ]'],
  ['vault-token', '[ -f "$HOME/.vault-token" ]'],
  ['pgpass', '[ -f "$HOME/.pgpass" ]'],
];

const DISCOVER_SCRIPT = [
  'set -f; tab=$(printf "\\t");',
  'export AWS_PAGER="";',
  // Every call bounded, where `timeout` exists.
  't() { if command -v timeout >/dev/null 2>&1; then timeout 10 "$@"; else "$@"; fi; };',
  // One line, tabs and newlines as spaces, at most 300 characters: an error or a version as evidence.
  'one() { tr "\\t\\n" "  " | sed "s/ *$//" | cut -c1-300; };',
  // The PATH and every executable on it.
  'o=$IFS; IFS=:; for d in $PATH; do IFS=$o;',
  '  [ -n "$d" ] || continue; printf "hopper-path %s\\n" "$d"; [ -d "$d" ] || continue;',
  '  set +f; for f in "$d"/*; do [ -f "$f" ] && [ -x "$f" ] && printf "hopper-bin %s\\n" "$f"; done; set -f;',
  'done; IFS=$o;',
  // The known tools' versions.
  'command -v aws >/dev/null 2>&1 && printf "hopper-version aws%s%s\\n" "$tab" "$(t aws --version 2>&1 | head -n 1 | one)";',
  'command -v terraform >/dev/null 2>&1 && printf "hopper-version terraform%s%s\\n" "$tab" "$(t terraform version 2>&1 | head -n 1 | one)";',
  'command -v tofu >/dev/null 2>&1 && printf "hopper-version tofu%s%s\\n" "$tab" "$(t tofu version 2>&1 | head -n 1 | one)";',
  'command -v kubectl >/dev/null 2>&1 && printf "hopper-version kubectl%s%s\\n" "$tab" "$(t kubectl version --client 2>&1 | head -n 1 | one)";',
  // AWS: the environment's own identity, then each profile's; what simulation allows it.
  'if command -v aws >/dev/null 2>&1; then',
  '  aw() { if [ -n "$p" ]; then t aws --profile "$p" "$@"; else t aws "$@"; fi; };',
  `  for p in "" $(t aws configure list-profiles 2>/dev/null | head -n ${MAX_PROFILES}); do`,
  '    n=${p:-(environment)};',
  '    if ! id=$(aw sts get-caller-identity --query "[Account,Arn]" --output text 2>&1); then',
  '      printf "hopper-aws-error %s%s%s\\n" "$n" "$tab" "$(printf "%s" "$id" | one)"; continue;',
  '    fi;',
  '    acct=$(printf "%s" "$id" | head -n 1 | cut -f1); arn=$(printf "%s" "$id" | head -n 1 | cut -f2);',
  '    region=$(aw configure get region 2>/dev/null | head -n 1);',
  '    printf "hopper-aws-identity %s%s%s%s%s%s%s\\n" "$n" "$tab" "$acct" "$tab" "$arn" "$tab" "$region";',
  // An assumed role is simulated as its role.
  '    role=$(printf "%s" "$arn" | sed -n "s|^arn:\\([^:]*\\):sts::\\([0-9]*\\):assumed-role/\\([^/]*\\)/.*$|arn:\\1:iam::\\2:role/\\3|p"); [ -n "$role" ] || role=$arn;',
  `    if sim=$(aw iam simulate-principal-policy --policy-source-arn "$role" --action-names ${AWS_WRITE_ACTIONS.join(' ')} --query "EvaluationResults[].[EvalActionName,EvalDecision]" --output text 2>&1); then`,
  '      printf "%s\\n" "$sim" | while IFS="$tab" read -r a d; do [ -n "$a" ] && printf "hopper-aws-sim %s%s%s%s%s\\n" "$n" "$tab" "$a" "$tab" "$d"; done;',
  '    else printf "hopper-aws-sim-error %s%s%s\\n" "$n" "$tab" "$(printf "%s" "$sim" | one)"; fi;',
  '  done;',
  'fi;',
  // kubectl: each context, its cluster and namespace, and the checks.
  'if command -v kubectl >/dev/null 2>&1; then',
  '  cur=$(t kubectl config current-context 2>/dev/null);',
  `  t kubectl config get-contexts -o name 2>/dev/null | head -n ${MAX_CONTEXTS} | while IFS= read -r c; do`,
  '    [ -n "$c" ] || continue;',
  '    ns=$(t kubectl config view --minify --context "$c" -o "jsonpath={..namespace}" 2>/dev/null | one);',
  '    cl=$(t kubectl config view --minify --context "$c" -o "jsonpath={.contexts[0].context.cluster}" 2>/dev/null | one);',
  '    k=""; [ "$c" = "$cur" ] && k=current;',
  '    printf "hopper-kube-context %s%s%s%s%s%s%s\\n" "$c" "$tab" "$cl" "$tab" "$ns" "$tab" "$k";',
  ...KUBE_CHECKS.map((check) => {
    const [verb, resource] = check.split(' ');
    return `    a=$(t kubectl --context "$c" auth can-i '${verb}' '${resource}' --all-namespaces --request-timeout=5s 2>&1 | head -n 1 | one); printf "hopper-kube-can %s%s%s%s%s\\n" "$c" "$tab" '${check}' "$tab" "$a";`;
  }),
  '  done;',
  'fi;',
  // Credential sources: names of variables, labels of files.
  `env | sed -n "s/^\\([A-Za-z_][A-Za-z0-9_]*\\)=.*/\\1/p" | grep -E '${CREDENTIAL_ENV}' | sort -u | sed "s/^/hopper-cred-env /";`,
  ...CREDENTIAL_FILES.map(([label, test]) => `${test} && printf "%s\\n" "hopper-cred-file ${label}";`),
  `printf "%s\\n" ${DISCOVER_DONE}`,
].map((l) => l.trim()).join(' ');

/** The argv that discovers a machine: run with HOPPER_JOB_ID unset, like every fixed script. */
export const discoverArgv = (): string[] => ['env', '-u', 'HOPPER_JOB_ID', 'sh', '-c', DISCOVER_SCRIPT, 'sh'];
