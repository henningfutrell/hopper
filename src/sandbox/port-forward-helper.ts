// The port-forward helper (issue #2146; design.md "Tools assembled per run"). An image with kubectl has it on PATH as
// `hopper-port-forward`: it runs one command while `kubectl port-forward` holds a local port on 127.0.0.1, and stops the
// forward when the command ends, so no forward outlives the command that asked for it. A box of a box step or a need
// step is burned when its command ends too: the helper is the first stop, the box the second.
//
// It is no boundary: what the forward reaches is the cluster's RBAC for the box's credential. It only makes the forward
// start, wait for its port and end in one command.

/** How long the helper waits for the forward's port by default, in seconds; `HOPPER_PORT_FORWARD_WAIT_S` changes it. */
export const PORT_FORWARD_WAIT_S = 30;

/** The helper, a POSIX shell script. */
export const PORT_FORWARD_HELPER = `#!/bin/sh
# hopper-port-forward (issue #2146): run COMMAND while kubectl port-forward holds 127.0.0.1:LOCAL, then stop the forward.
#   hopper-port-forward [-n NAMESPACE] [--context NAME] TARGET LOCAL[:REMOTE] -- COMMAND [ARG...]
#   TARGET: svc/NAME, pod/NAME or deploy/NAME, as kubectl port-forward takes it.
#   Nest it for more than one forward: hopper-port-forward ... -- hopper-port-forward ... -- COMMAND
# Exit: COMMAND's own; 1: the forward did not start (kubectl's output is on stderr); 2: a bad call.
set -u
usage() { echo 'usage: hopper-port-forward [-n NAMESPACE] [--context NAME] TARGET LOCAL[:REMOTE] -- COMMAND [ARG...]' >&2; exit 2; }
ns=; ctx=
while [ $# -gt 0 ]; do
  case $1 in
    -n|--namespace) [ $# -ge 2 ] || usage; ns=$2; shift 2 ;;
    --namespace=*) ns=\${1#*=}; shift ;;
    --context) [ $# -ge 2 ] || usage; ctx=$2; shift 2 ;;
    --context=*) ctx=\${1#*=}; shift ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ $# -ge 4 ] && [ "$3" = "--" ] || usage
target=$1; ports=$2; shift 3
local=\${ports%%:*}
case $local in ''|*[!0-9]*) usage ;; esac
wait_s=\${HOPPER_PORT_FORWARD_WAIT_S:-${PORT_FORWARD_WAIT_S}}
log=$(mktemp) || exit 1
kubectl \${ctx:+--context "$ctx"} \${ns:+--namespace "$ns"} port-forward --address 127.0.0.1 "$target" "$ports" >"$log" 2>&1 &
pf=$!
stop() { kill "$pf" 2>/dev/null; wait "$pf" 2>/dev/null; rm -f "$log"; }
trap stop EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
ticks=0
until grep -q "^Forwarding from 127\\.0\\.0\\.1:$local " "$log"; do
  if ! kill -0 "$pf" 2>/dev/null; then
    cat "$log" >&2
    echo "hopper-port-forward: kubectl port-forward $target ended before 127.0.0.1:$local was ready" >&2
    exit 1
  fi
  ticks=$((ticks + 1))
  if [ "$ticks" -gt $((wait_s * 10)) ]; then
    cat "$log" >&2
    echo "hopper-port-forward: 127.0.0.1:$local was not ready after $wait_s s" >&2
    exit 1
  fi
  sleep 0.1
done
"$@"
`;
