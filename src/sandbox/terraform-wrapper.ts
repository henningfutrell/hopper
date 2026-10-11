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
