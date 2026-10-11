// The read-only terraform wrapper (issue #715; design.md "A read-only infra box"). A box of a read-only template has it
// first on PATH, in front of the real binary in $HOPPER_TOOLS. It runs the commands that read, and refuses each one that
// writes infrastructure or state before the real binary sees it: an allow-list, so a command terraform adds later is
// refused until it is named here. plan takes no state lock (a lock is a write to the lock table), and init with a lock
// file keeps it as it is. TF_CLI_ARGS cannot add a flag past it.
//
// It is one layer, not the boundary: the box's AWS session is read-only and denies every write (src/domain/minting.ts),
// so the real binary, called past the wrapper, is refused by the account too. The read-only check proves both.

/** Each refusal says this, so the read-only check reads it as a refusal (`DENIAL`, src/sandbox/probes.ts). */
export const WRAPPER_REFUSAL = 'refused by the read-only wrapper';

/** The wrapper, a POSIX shell script. */
export const TERRAFORM_WRAPPER = `#!/bin/sh
# The hopper's read-only terraform wrapper (issue #715). The real binary is in $HOPPER_TOOLS; the box's AWS session
# refuses every write even past this wrapper.
set -u
for v in $(env | sed -n 's/^\\(TF_CLI_ARGS[A-Za-z_]*\\)=.*/\\1/p'); do unset "$v"; done
real="\${HOPPER_TOOLS:-/opt/hopper-tools/bin}/terraform"
refuse() {
  echo "terraform $1: ${WRAPPER_REFUSAL}. This box only reads: it runs init, plan, show, validate, output, providers, version, state list, state show, workspace list and workspace show." >&2
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
  ''|version|show|validate|output|providers) exec "$real" "$@" ;;
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
