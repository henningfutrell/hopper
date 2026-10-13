// The read-only terraform wrapper (issue #715; design.md "A read-only infra box"). A box of a read-only template has it
// first on PATH, in front of the real binary in $HOPPER_TOOLS. It runs the commands that read, and refuses each one that
// writes infrastructure or state before the real binary sees it: an allow-list, so a command terraform adds later is
// refused until it is named here. plan takes no state lock (a lock is a write to the lock table), and init with a lock
// file keeps it as it is. TF_CLI_ARGS cannot add a flag past it. Every command runs with the image's CLI config, which
// installs providers only from the mirror in the image (TERRAFORM_CLI_CONFIG): no provider is downloaded, and `providers
// lock` and `providers mirror`, which ask the registry past that config, are refused.
//
// It is one layer, not the boundary: the box's AWS session is read-only and denies every write (src/domain/minting.ts),
// so the real binary, called past the wrapper, is refused by the account too. The read-only check proves both.

/** Each refusal says this, so the read-only check reads it as a refusal (`DENIAL`, src/sandbox/probes.ts). */
export const WRAPPER_REFUSAL = 'refused by the read-only wrapper';

/** Where a read-only image keeps the providers terraform may install: a filesystem mirror, in its packed layout. */
export const PROVIDER_MIRROR = '/opt/hopper-tools/providers';

/**
 * The CLI config of a read-only image (`TF_CLI_CONFIG_FILE`): providers come from the mirror and from nowhere else. With
 * no `direct` block, terraform asks no registry, so `init` of a provider the image does not hold fails.
 */
export const TERRAFORM_CLI_CONFIG = `provider_installation {
  filesystem_mirror {
    path = "${PROVIDER_MIRROR}"
  }
}
`;

/** The wrapper, a POSIX shell script. */
export const TERRAFORM_WRAPPER = `#!/bin/sh
# The hopper's read-only terraform wrapper (issue #715). The real binary is in $HOPPER_TOOLS; the box's AWS session
# refuses every write even past this wrapper.
set -u
for v in $(env | sed -n 's/^\\(TF_CLI_ARGS[A-Za-z_]*\\)=.*/\\1/p'); do unset "$v"; done
tools="\${HOPPER_TOOLS:-/opt/hopper-tools/bin}"
real="$tools/terraform"
# Providers only from the image's mirror, whatever the caller set.
export TF_CLI_CONFIG_FILE="\${tools%/bin}/terraform.rc"
refuse() {
  echo "terraform $1: ${WRAPPER_REFUSAL}. This box only reads: it runs init, plan, show, validate, output, providers, providers schema, version, state list, state show, workspace list and workspace show." >&2
  exit 1
}
dir=. cmd= sub= next=
for a in "$@"; do
  if [ -n "$next" ]; then dir=$a; next=; continue; fi
  if [ -z "$cmd" ]; then
    case $a in
      -chdir=*) dir=\${a#-chdir=} ;;
      -chdir) next=1 ;;
      -*) ;;
      *) cmd=$a ;;
    esac
  else
    sub=$a
    break
  fi
done
case $cmd in
  ''|version|show|validate|output) exec "$real" "$@" ;;
  providers)
    case $sub in
      ''|schema|-*) exec "$real" "$@" ;;
      *) refuse "providers $sub" ;;
    esac ;;
  plan)
    for a in "$@"; do
      case $a in
        -lock=false) exec "$real" "$@" ;;
        -lock|-lock=*) refuse "plan $a" ;;
      esac
    done
    exec "$real" "$@" -lock=false ;;
  init)
    lockfile=
    for a in "$@"; do
      case $a in
        -upgrade|-upgrade=*|-migrate-state|-migrate-state=*|-force-copy|-force-copy=*) refuse "init $a" ;;
        -lockfile=*) lockfile=1 ;;
      esac
    done
    if [ -z "$lockfile" ] && [ -f "$dir/.terraform.lock.hcl" ]; then exec "$real" "$@" -lockfile=readonly; fi
    exec "$real" "$@" ;;
  state)
    case $sub in
      list|show) exec "$real" "$@" ;;
      *) refuse "state $sub" ;;
    esac ;;
  workspace)
    case $sub in
      list|show) exec "$real" "$@" ;;
      *) refuse "workspace $sub" ;;
    esac ;;
  *) refuse "$cmd" ;;
esac
`;

// The apply wrapper (issue #870, part 5; design.md "Infra plans: the apply wrapper on write boxes"). Every other image
// with terraform has it first on PATH, in front of the real binary in $HOPPER_TOOLS: no apply without a plan. `apply`
// runs only the saved plan file of a plan the hopper recorded — the plan HOPPER_PLAN names, fetched from the hopper with
// the job's proxy token (`GET /job/infra-plans/:id?file=1`) — and a plan file the caller names must be that file, by its
// SHA-256. An apply flag that would change what the saved plan does is refused, and so is each other command that writes
// infrastructure or state with no plan: destroy (a destroy is a plan too), import, refresh, taint, untaint,
// force-unlock, `state rm|mv|push|replace-provider`, `workspace delete`. The rest goes to the real binary as given.
//
// It is one layer, not the boundary: the vault mints a write credential only for an approved, current plan (the apply
// gate, src/infra-plans/service.ts), so the real binary, called past the wrapper, gets no credential without one.

/** Each refusal says this. */
export const APPLY_WRAPPER_REFUSAL = 'refused by the apply wrapper';

/** The wrapper, a POSIX shell script. It needs curl and sha256sum, as the job's other helpers do. */
export const TERRAFORM_APPLY_WRAPPER = `#!/bin/sh
# The hopper's apply wrapper (issue #870): no apply without a plan. The real binary is in $HOPPER_TOOLS;
# the vault mints a write credential only for an approved, current plan even past this wrapper.
set -u
for v in $(env | sed -n 's/^\\(TF_CLI_ARGS[A-Za-z_]*\\)=.*/\\1/p'); do unset "$v"; done
real="\${HOPPER_TOOLS:-/opt/hopper-tools/bin}/terraform"
refuse() {
  echo "terraform $1: ${APPLY_WRAPPER_REFUSAL}. $2" >&2
  exit 1
}
NOPLAN="There is no apply without a plan: run terraform plan -out, record the plan with the hopper (POST /job/infra-plans, with the saved plan file), have it approved, then run terraform apply with HOPPER_PLAN set to the plan's id."
dir=. cmd= sub= next=
for a in "$@"; do
  if [ -n "$next" ]; then dir=$a; next=; continue; fi
  if [ -z "$cmd" ]; then
    case $a in
      -chdir=*) dir=\${a#-chdir=} ;;
      -chdir) next=1 ;;
      -*) ;;
      *) cmd=$a ;;
    esac
  else
    sub=$a
    break
  fi
done
case $cmd in
  apply) ;;
  destroy) refuse destroy "$NOPLAN A destroy is a plan too: terraform plan -destroy -out." ;;
  import|refresh|taint|untaint|force-unlock) refuse "$cmd" "$NOPLAN" ;;
  state)
    case $sub in
      rm|mv|push|replace-provider|import) refuse "state $sub" "$NOPLAN" ;;
      *) exec "$real" "$@" ;;
    esac ;;
  workspace)
    case $sub in
      delete) refuse "workspace delete" "$NOPLAN" ;;
      *) exec "$real" "$@" ;;
    esac ;;
  *) exec "$real" "$@" ;;
esac
plan=\${HOPPER_PLAN:-}
[ -n "$plan" ] || refuse apply "$NOPLAN"
case $plan in
  *[!0-9a-f-]*) refuse apply "HOPPER_PLAN must be a plan's id, as the hopper answered when it recorded the plan." ;;
esac
# The flags an apply of a saved plan takes, and at most one plan file.
seen= named= next=
for a in "$@"; do
  if [ -n "$next" ]; then next=; continue; fi
  if [ -z "$seen" ]; then
    case $a in -chdir) next=1 ;; apply) seen=1 ;; esac
    continue
  fi
  case $a in
    -auto-approve|-auto-approve=*|-input=*|-no-color|-compact-warnings|-json|-lock=*|-lock-timeout=*|-parallelism=*) ;;
    -*) refuse "apply $a" "An apply runs the saved plan as it is: plan again with what you need." ;;
    *)
      [ -z "$named" ] || refuse apply "An apply takes one plan file."
      named=$a ;;
  esac
done
path=
if [ -n "$named" ]; then
  case $named in /*) path=$named ;; *) path="$dir/$named" ;; esac
  [ -r "$path" ] || refuse apply "$named cannot be read."
fi
[ -n "\${HOPPER_URL:-}" ] && [ -r "\${HOPPER_TOKEN_FILE:-}" ] || refuse apply "the job has no way to the hopper (HOPPER_URL, HOPPER_TOKEN_FILE), so the saved file of plan $plan cannot be fetched."
tmp=$(mktemp "\${TMPDIR:-/tmp}/hopper-plan.XXXXXX") || refuse apply "no temporary file for the plan."
trap 'rm -f "$tmp"' EXIT
code=$(printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")" | curl -sS -H @- -o "$tmp" -w '%{http_code}' "$HOPPER_URL/job/infra-plans/$plan?file=1" 2>/dev/null) \\
  || refuse apply "the hopper cannot be reached at $HOPPER_URL, so the saved file of plan $plan cannot be fetched."
[ "$code" = 200 ] || refuse apply "the hopper gives no saved plan file for plan $plan ($code): $(head -c 500 "$tmp")"
if [ -n "$path" ] && [ "$(sha256sum < "$path" | cut -d' ' -f1)" != "$(sha256sum < "$tmp" | cut -d' ' -f1)" ]; then
  refuse apply "$named is not the saved plan file of plan $plan: apply the plan the hopper recorded, or record this one."
fi
# The same command, the plan file the caller named left out, and the plan's saved file last.
n=$# seen= next=
while [ "$n" -gt 0 ]; do
  a=$1; shift; n=$((n - 1))
  if [ -n "$next" ]; then next=; set -- "$@" "$a"; continue; fi
  if [ -z "$seen" ]; then
    case $a in -chdir) next=1 ;; apply) seen=1 ;; esac
    set -- "$@" "$a"
    continue
  fi
  case $a in -*) set -- "$@" "$a" ;; esac
done
"$real" "$@" "$tmp"
exit $?
`;
