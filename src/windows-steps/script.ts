// `hopper-step` (issue #731): the command a job runs to have the hopper run one step on a Windows host — a .NET
// Framework build, a Windows app's tests, a packing step — and get its log, its exit code and its outputs back; and
// (issue #1004) one step in a sandbox of the template the job's sandbox request was approved for, made for that step and
// burned after it (issue #1349), with credentials minted for it; and (issue #1007) one step by its needs. Kept
// in the job's credentials dir beside its proxy token, `hopper-gh` and `hopper-skill`, run as `sh "$HOPPER_STEP"`: POSIX
// sh, curl, tar and od, nothing else. Its full help is the `windows-step` and `box-step` skills' text.
import { ACTION_ROLE } from '../domain/action-grants.ts';
import { STEP_RUNS_MAX } from '../domain/windows-steps.ts';
import { TRACE_HEADER_SH } from '../github-proxy/retry-after.ts';

export const STEP_SCRIPT_VARIABLE = 'HOPPER_STEP';

/** The routes on the hopper's URL a job's step requests go to. */
export const STEP_PATH = '/job/step';

/** The file under the job's credentials dir. */
export const STEP_SCRIPT_FILE = 'hopper/step';

/** The response headers: the step's id on the ask, its exit code and the hopper's problem on the result; a log read's next start and state (issues #1568, #1611). */
export const STEP_HEADER = { id: 'x-hopper-step', exit: 'x-hopper-step-exit', problem: 'x-hopper-step-problem', logNext: 'x-hopper-step-log-next', state: 'x-hopper-step-state', sha256: 'x-hopper-step-outputs-sha256' } as const;

/** The exit code the script ends with when the hopper did not run the step, or could not bring it all back. */
export const STEP_NOT_RUN = 125;

/** Where `--script FILE` goes in the inputs: the step's scratch directory on the host, removed after the step. */
export const STEP_SCRIPT_INPUT = '.hopper-step/script.ps1';
/** Where a box or need step's `--script FILE` goes in the inputs (issue #1004): in the sandbox's work dir, burned with it. */
export const BOX_SCRIPT_INPUT = '.hopper-step/script.sh';

/** What a job reads when it loads the `windows-step` skill. */
export const STEP_HELP = `windows-step: run one step on a Windows host, from this Linux machine.

No agent, client or work tree runs on Windows. When the work needs Windows (a .NET Framework build, a Windows app's
tests, a packing step), the hopper runs that one step on a Windows host a person set up, over ssh, in PowerShell, in
that host's working directory. The step's output streams back here as it runs; then its exit code and its outputs.
The hopper keeps each step until it ends: a broken connection does not stop it, and a hopper that stops never runs it
twice (the step then ends with exit ${STEP_NOT_RUN} and says so), unless you ask with --rerun. Stop hopper-step (a
signal) and the step stops.

  sh "$HOPPER_STEP" hosts                     the Windows hosts: name, working directory, label, the secrets it gives
  sh "$HOPPER_STEP" run HOST (--command TEXT | --script FILE) [--input PATH]... [--output PATH]...
                         [--secret NAME]... [--timeout SECONDS] [--into DIR] [--rerun]
    --command TEXT     PowerShell to run in the host's working directory (at most 4 KiB)
    --script FILE      a PowerShell script of this machine's to run instead (any size)
    --input PATH       a file or directory, relative to the current directory: copied into the host's working
                       directory, at the same relative path, before the command runs. Repeat for more.
    --output PATH      a file or directory, relative to the host's working directory: brought back after the command
                       ends, into --into DIR (default: the current directory). Repeat for more.
    --secret NAME      a vault secret the host gives (see hosts): the step gets it as the environment variable NAME
                       ($env:NAME). It goes only to the step, never to this machine; the step's log shows *** for
                       it. The first ask of a job with no vault grant is refused, and a person is asked to grant it.
                       Repeat for more.
    --timeout SECONDS  how long the step may run (default 1800, at most 14400): then it is stopped
    --rerun            the step is safe to run again (it only reads, or does the same each time): when the hopper
                       stops while the step runs, it runs the step again from the start once it is back, ${STEP_RUNS_MAX} times
                       in all at the most, and the log says so. Without it, such a step ends with exit ${STEP_NOT_RUN}.
Exit: the step's own exit code; ${STEP_NOT_RUN}: the hopper did not run it, stopped it, or could not bring it all back
(the reason is on stderr); 2: a bad call.

One step runs on a host at a time: a step waits while another runs there, and says so. The host keeps no scratch:
the hopper removes what it copied there for the step when the step ends, also after a hopper that stopped. Inputs
overwrite files of the same name in the working directory, and stay there. Inputs and outputs: at most 32 MiB each. A step is on this job's timeline: its host, command, exit code and time.
The step gets no GitHub token and no credential but the vault secrets it asks for with --secret. GitHub stays here:
fetch, push and open pull requests from this machine. Do not print a secret, or write it into an output: the hopper
masks only the log.

Example: build a solution on the host, and bring the build back.
  sh "$HOPPER_STEP" run build-host --input src --command "msbuild App.sln /p:Configuration=Release" --output src/App/bin/Release --into out
Example: push a package with a key from the vault.
  sh "$HOPPER_STEP" run build-host --secret NUGET_TOKEN --command 'nuget push out\\App.nupkg -ApiKey $env:NUGET_TOKEN'`;

/** What a job reads when it loads the `box-step` skill (issue #1004). */
export const BOX_STEP_HELP = `box-step: run one step in a sandbox, from the machine this job runs on.

A job does not move to a sandbox. When the work needs the assets of the template its sandbox request was approved for
(sh "$HOPPER_SKILL" sandbox), the hopper runs each step of it in a sandbox of that template, under sh, in the sandbox's
work directory ($HOME/work there). Each step gets a new sandbox, which the hopper destroys when the step ends: nothing
is kept between steps, so bring back what the next step needs with --output and send it again with --input. The step's
output streams back here as it runs; then its exit code and its outputs. This job's work tree, its GitHub and its agent
stay here.

  sh "$HOPPER_STEP" hosts                     the Windows hosts, then this job's approved sandboxes: box TEMPLATE  template TEMPLATE
  sh "$HOPPER_STEP" box TEMPLATE (--command TEXT | --script FILE) [--input PATH]... [--output PATH]...
                         [--plan-id ID] [--timeout SECONDS] [--into DIR]
    --command TEXT     sh to run in the sandbox's work directory (at most 4 KiB)
    --script FILE      a sh script of this machine's to run instead (any size)
    --input PATH       a file or directory, relative to the current directory: copied into the sandbox's work
                       directory, at the same relative path, before the command runs. Repeat for more.
    --output PATH      a file or directory, relative to the sandbox's work directory: brought back after the command
                       ends, into --into DIR (default: the current directory). Repeat for more.
    --plan-id ID       the id of the approved infra plan the step applies: the template's changes are minted too, and
                       the plan's saved file is in the sandbox (terraform apply there applies it)
    --timeout SECONDS  how long the step may run (default 1800, at most 14400): then it is stopped
Exit: the step's own exit code; ${STEP_NOT_RUN}: the hopper did not run it, stopped it, or could not bring it all back
(the reason is on stderr); 2: a bad call.

Only a template this job's own sandbox request was approved for. The hopper keeps each step until it ends: a broken
connection does not stop it, and a hopper that stops never runs it twice (the step then ends with exit ${STEP_NOT_RUN} and
says so). Stop hopper-step (a signal) and the step stops. Inputs: at most 32 MiB.

Credentials. The hopper mints a short-lived credential for each of the template's AWS roles, clusters and namespaces,
for that step only, after Access: its reads, and with --plan-id its changes too. They are in the sandbox's environment,
set up as for a need step: one AWS role is the AWS CLI's default; each AWS role is also a profile named
<account>-<role>; each cluster or namespace is a kubectl context named for it, the first one current. The template's
vault secrets come too, after a person granted this job the vault (else the step ends with exit ${STEP_NOT_RUN} and a person is
asked): read one in the step with "$("$HOPPER_SECRET" get NAME)" (files in $HOPPER_SECRETS_DIR). A step takes no --secret,
no credential reaches this machine, and outputs that hold a secret's value are not brought back. Never print a credential.

Example: check who the sandbox is on AWS, and bring back a plan.
  sh "$HOPPER_STEP" box asked-0a1b2c3d4e5f --input infra --command 'cd infra && terraform plan -no-color > plan.txt' --output infra/plan.txt`;

/** How often a step's ask is sent before hopper-step gives up: the same key each time (issues #1568, #1611). */
export const STEP_ASK_TRIES = 5;
/** How many log reads in a row may fail, one a second, before hopper-step gives up: a hopper restart fits in it. */
export const STEP_LOG_MISSES = 300;

/** How often `hopper-step need` asks again while the template for its needs waits, in seconds. */
export const STEP_READY_POLL_S = 10;
/** How long `hopper-step need` waits for that template by default, in seconds. */
export const STEP_READY_WAIT_S = 1800;

/** What a job reads when it loads the `need-step` skill (issue #1007). */
export const NEED_STEP_HELP = `need-step: run one command that needs AWS, Kubernetes, helm or terraform, from this machine.

This machine holds no AWS, Kubernetes or terraform credential, and never gets one. When a command needs an account or a
cluster, name what it needs: the hopper runs that one command in a one-shot need box of a template that covers the needs,
with a short-lived credential it mints for that command only, in its environment. No box to ask for first. The output streams back here as it runs; then the exit code
and the outputs. This job stays on this machine and goes on with its work.

  sh "$HOPPER_STEP" need NEEDS --why TEXT [--plan TEXT] [--plan-id ID] [--action ACTION=ARN]... (--command TEXT | --script FILE)
                         [--input PATH]... [--output PATH]... [--timeout SECONDS] [--into DIR] [--wait SECONDS]
    NEEDS              what the command needs, as <operation>/<kind>/<asset>, split by spaces:
                       read/aws-role/123456789012/readonly, read/cluster/NAME, read/namespace/CLUSTER/NS,
                       write/aws-role/123456789012/deploy. Name only what the command needs.
    --why TEXT         why the job needs it, in one or two sentences, for the person who approves it
    --plan TEXT        for a need that changes an asset: what the command does, and whether it can be undone
    --plan-id ID       for a need that changes an asset: the id of the approved infra plan the change applies. Its
                       saved plan file is in the box: terraform apply there applies it (no file to name)
    --action ACTION=ARN  for the one change on an aws-role: an AWS action it needs that the role's own access does not
                       give, and the resource it acts on (eks:UpdateNodegroupConfig=arn:aws:eks:…:nodegroup/C/G/*).
                       A person grants each once, on Access requests; the session then reads, and does only the
                       granted actions. Use the account's ${ACTION_ROLE} role for it. Repeat for more (at most 10).
                       The grant approves the change: it needs no --plan-id. Name the exact call and its undo in --plan.
    --command TEXT     sh to run in the need box's work directory (at most 4 KiB). The tools are there: aws, kubectl,
                       helm, terraform, as the needs ask.
    --script FILE      a script of this machine's to run instead (with sh)
    --input PATH       a file or directory, relative to the current directory: copied into the work directory first.
                       Repeat for more.
    --output PATH      a file or directory, relative to the work directory: brought back into --into DIR (default:
                       the current directory). Repeat for more.
    --timeout SECONDS  how long the command may run (default 1800, at most 14400): then it is stopped
    --wait SECONDS     how long to wait for the template to be ready (default ${STEP_READY_WAIT_S})
Exit: the command's own exit code; ${STEP_NOT_RUN}: the hopper did not run it, stopped it, or could not bring it all back
(the reason is on stderr); 2: a bad call.

The first ask for a set of needs makes a template for them. Reads the user's policy holds are approved at once; a change
waits for a person's approval. While it waits, hopper-step asks again by itself and runs the command when it is ready.
When --wait runs out first, end your turn with HOPPER_WAITING (for: the sandbox template; on: vault grant when it waits
on an action grant): the hopper ends your wait when it is ready. Then run the same command again. An action a person
granted stays granted for later steps of the same role, action and resource. When infra applies are off, no action is
asked: the change goes through CI. The same needs use the same template, never a second one.
In the box: one AWS role is the AWS CLI's default; each AWS role is also a profile named <account>-<role>. Each cluster
or namespace is a kubectl context named for it (a namespace: <cluster>-<ns>), the first one current.
A step is on this job's timeline: its box, needs, command, exit code and time. Never print a credential.
The hopper keeps each step until it ends: a broken connection does not stop it, and a hopper that stops never runs it
twice (the step then ends with exit ${STEP_NOT_RUN} and says so). Stop hopper-step (a signal) and the step stops. Inputs:
at most 32 MiB.

Example: who am I in an account, read only.
  sh "$HOPPER_STEP" need "read/aws-role/123456789012/readonly" --why "Check which role the dig runs as" --command "aws sts get-caller-identity"
Example: list the pods of a namespace, and bring a report back.
  sh "$HOPPER_STEP" need "read/namespace/lab/web" --why "Find the pod that restarts" --command "kubectl get pods -o wide > pods.txt" --output pods.txt
Example: apply an approved terraform plan (record it first: POST /job/infra-plans, with the saved plan file).
  sh "$HOPPER_STEP" need "apply/aws-role/123456789012/deploy" --why "Add the rule the plan holds" --plan-id PLAN_ID --input infra --command "cd infra && terraform init -input=false && terraform apply -auto-approve"
Example: an action the deploy role cannot do, with no infra plan (a person grants it once; the grant approves it).
  sh "$HOPPER_STEP" need "apply/aws-role/123456789012/${ACTION_ROLE}" --action "eks:UpdateNodegroupConfig=arn:aws:eks:us-west-1:123456789012:nodegroup/prod/nodes/*" --why "Scale the node group to 6 nodes" --plan "aws eks update-nodegroup-config --cluster-name prod --nodegroup-name nodes --scaling-config desiredSize=6; undone by the same call with desiredSize=3" --command "aws eks update-nodegroup-config --cluster-name prod --nodegroup-name nodes --scaling-config desiredSize=6"`;

/** The script. The token goes to curl on stdin, never on a command line; every value in a URL is percent-encoded. */
export const STEP_SCRIPT = `#!/bin/sh
# hopper-step — run one step on a Windows host (issue #731), in a sandbox of a template this job's sandbox request was
# approved for (issues #1004, #1349), or in a one-shot need box by its needs (issue #1007), each sandbox burned after its
# step, with credentials the hopper mints for it. Written by the hopper at each job start.
#   sh "$HOPPER_STEP" hosts
#   sh "$HOPPER_STEP" run HOST (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--secret NAME]... [--timeout SECONDS] [--into DIR] [--rerun]
#   sh "$HOPPER_STEP" box TEMPLATE (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--plan-id ID] [--timeout SECONDS] [--into DIR]
#   sh "$HOPPER_STEP" need NEEDS --why TEXT [--plan TEXT] [--plan-id ID] [--action ACTION=ARN]... (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--timeout SECONDS] [--into DIR] [--wait SECONDS]
# Load the windows-step, box-step or need-step skill for the full help: sh "$HOPPER_SKILL" windows-step
# Exit: the step's own exit code; ${STEP_NOT_RUN}: the hopper did not run it, stopped it, or could not bring it all back; 2: a bad call.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_STEP" hosts | run HOST (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--secret NAME]... [--timeout SECONDS] [--into DIR] [--rerun] | box TEMPLATE (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--plan-id ID] [--timeout SECONDS] [--into DIR] | need NEEDS --why TEXT [--plan TEXT] [--plan-id ID] [--action ACTION=ARN]... (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--timeout SECONDS] [--into DIR] [--wait SECONDS]' >&2; exit 2; }
${TRACE_HEADER_SH}
# The job's token, and its trace parent (issue #1486 part 6): the hopper's span for each request is a child of the job's run span.
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; trace_header; }
# Every byte as %XX: safe in a URL whatever the text holds.
enc() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \\n' | sed 's/../%&/g'; }
# A response header's value, from a header dump.
header() { awk -v h="$1:" 'tolower($1) == h { sub(/^[^:]*:[ ]*/, ""); sub(/\\r$/, ""); v = $0 } END { print v }' "$2"; }
needonly() { [ "$at" = needs ] || { echo "no: $1 is for a need step: sh \\"\\$HOPPER_STEP\\" need ..." >&2; exit 2; }; }
[ $# -ge 1 ] || usage
tmp=$(mktemp -d "\${TMPDIR:-/tmp}/hopper-step.XXXXXX") || exit ${STEP_NOT_RUN}
trap 'rm -rf "$tmp"' EXIT
cmd=$1; shift
if [ "$cmd" = hosts ]; then
  code=$(token | curl -sS -H @- -o "$tmp/body" -w '%{http_code}' "$HOPPER_URL${STEP_PATH}") || exit ${STEP_NOT_RUN}
  cat "$tmp/body"
  [ "$code" = 200 ] || exit ${STEP_NOT_RUN}
  exit 0
fi
case $cmd in run) at=host ;; box) at=box ;; need) at=needs ;; *) usage ;; esac
[ $# -ge 1 ] || usage
place=$1; shift
command=; script=; into=.; q=; wait=${STEP_READY_WAIT_S}; : > "$tmp/inputs"
while [ $# -gt 0 ]; do
  case $1 in
    --rerun) [ "$at" = host ] || { echo 'no: --rerun is for a Windows step: a sandbox step runs in a new sandbox each time' >&2; exit 2; }; q="$q&rerun=1" ;;
    --command|--script|--input|--output|--secret|--timeout|--into|--why|--plan|--plan-id|--action|--wait)
      [ $# -ge 2 ] || usage
      case $1 in
        --command) command=$2 ;;
        --script) script=$2 ;;
        --input) [ -e "$2" ] || { echo "no: $2 is not here" >&2; exit 2; }; printf '%s\\n' "$2" >> "$tmp/inputs" ;;
        --output) q="$q&output=$(enc "$2")" ;;
        --secret) [ "$at" = host ] || { echo 'no: a sandbox step gets the credentials the hopper mints for it, never a vault secret by name' >&2; exit 2; }; q="$q&secret=$(enc "$2")" ;;
        --timeout) q="$q&timeout=$(enc "$2")" ;;
        --into) into=$2 ;;
        --why) needonly --why; q="$q&why=$(enc "$2")" ;;
        --plan) needonly --plan; q="$q&plan=$(enc "$2")" ;;
        --plan-id) if [ "$at" = host ]; then needonly --plan-id; fi; q="$q&planId=$(enc "$2")" ;;
        --action) needonly --action; q="$q&action=$(enc "$2")" ;;
        --wait) needonly --wait; wait=$2 ;;
      esac
      shift ;;
    *) usage ;;
  esac
  shift
done
if [ -n "$script" ]; then
  [ -z "$command" ] || { echo 'no: give --command or --script, not both' >&2; exit 2; }
  [ -f "$script" ] && [ -r "$script" ] || { echo "no: $script is not a file this job can read" >&2; exit 2; }
  mkdir -p "$tmp/s/.hopper-step" || exit ${STEP_NOT_RUN}
  if [ "$at" != host ]; then
    sinput=${BOX_SCRIPT_INPUT}; command="sh ./${BOX_SCRIPT_INPUT}"
  else
    sinput=${STEP_SCRIPT_INPUT}; command="& '.\\\\.hopper-step\\\\script.ps1'"
  fi
  cp "$script" "$tmp/s/$sinput" || exit ${STEP_NOT_RUN}
fi
[ -n "$command" ] || usage
if [ "$at" = needs ]; then
  # The template for the needs first: made once, and while it waits for a person or its check, asked again by itself.
  case $wait in ''|*[!0-9]*) echo 'no: --wait is whole seconds' >&2; exit 2 ;; esac
  end=$(( $(date +%s) + wait )); told=
  while :; do
    code=$(token | curl -sS -H @- -X POST -o "$tmp/ready" -w '%{http_code}' "$HOPPER_URL${STEP_PATH}?needs=$(enc "$place")&ready=1$q") || { echo 'hopper-step: the hopper could not be reached' >&2; exit ${STEP_NOT_RUN}; }
    [ "$code" = 200 ] && break
    [ "$code" = 202 ] || { cat "$tmp/ready" >&2; exit ${STEP_NOT_RUN}; }
    [ -n "$told" ] || { sed 's/^/hopper-step: /' "$tmp/ready" >&2; told=1; }
    if [ "$(date +%s)" -ge "$end" ]; then
      echo "hopper-step: still waiting after $wait s. End your turn with HOPPER_WAITING (for: the sandbox template for $place, or the action grant the hopper named; on: vault grant for an action grant): the hopper ends your wait when it is ready. Then run this again." >&2
      exit ${STEP_NOT_RUN}
    fi
    sleep "\${HOPPER_STEP_POLL_S:-${STEP_READY_POLL_S}}"
  done
  [ -z "$told" ] || echo 'hopper-step: the template is ready; the step runs now' >&2
fi
if [ -s "$tmp/inputs" ] || [ -n "$script" ]; then
  set --
  [ -s "$tmp/inputs" ] && set -- "$@" -T "$tmp/inputs"
  [ -n "$script" ] && set -- "$@" -C "$tmp/s" "$sinput"
  tar -cf "$tmp/in.tar" "$@" || { echo 'no: the inputs could not be packed' >&2; exit ${STEP_NOT_RUN}; }
else
  : > "$tmp/in.tar"
fi
# Each step is kept by the hopper and runs there by itself (issues #1568, #1611): asked with a key of this ask's own,
# so an ask sent again after a broken connection is the same step, never a second one. Then its log is read until it
# ends, and the outputs after.
key=$(od -An -N12 -tx1 /dev/urandom | tr -d ' \\n')
tries=0
until code=$(token | curl -sS -H @- -H 'expect:' -H 'content-type: application/x-tar' --data-binary @"$tmp/in.tar" -D "$tmp/head" -o "$tmp/asked" -w '%{http_code}' \\
  "$HOPPER_URL${STEP_PATH}?$at=$(enc "$place")&key=$key&command=$(enc "$command")$q"); do
  tries=$((tries + 1))
  [ "$tries" -lt ${STEP_ASK_TRIES} ] || { echo 'hopper-step: the hopper could not be reached' >&2; exit ${STEP_NOT_RUN}; }
  sleep 2
done
[ "$code" = 202 ] || { cat "$tmp/asked"; exit ${STEP_NOT_RUN}; }
id=$(header ${STEP_HEADER.id} "$tmp/head")
# Stopped here, the step is stopped there.
trap 'token | curl -sS -H @- -X DELETE -o /dev/null "$HOPPER_URL${STEP_PATH}/$id" 2>/dev/null; exit 130' INT TERM HUP
from=0; misses=0
while :; do
  if code=$(token | curl -sS -H @- -D "$tmp/loghead" -o "$tmp/log" -w '%{http_code}' "$HOPPER_URL${STEP_PATH}/$id/log?from=$from" 2>/dev/null); then
    misses=0
    [ "$code" = 200 ] || { cat "$tmp/log" >&2; exit ${STEP_NOT_RUN}; }
    cat "$tmp/log"
    from=$(header ${STEP_HEADER.logNext} "$tmp/loghead")
    [ "$(header ${STEP_HEADER.state} "$tmp/loghead")" = ended ] && break
  else
    # The hopper away a while (a restart): the step goes on there, and is read again when it is back.
    misses=$((misses + 1))
    [ "$misses" -lt ${STEP_LOG_MISSES} ] || { echo "hopper-step: the hopper could not be reached for ${STEP_LOG_MISSES} s; step $id may still run there" >&2; exit ${STEP_NOT_RUN}; }
  fi
  sleep 1
done
trap - INT TERM HUP
code=$(token | curl -sS -H @- -D "$tmp/head2" -o "$tmp/out.tar" -w '%{http_code}' "$HOPPER_URL${STEP_PATH}/$id") || { echo 'hopper-step: the hopper could not be reached, or the outputs did not arrive whole' >&2; exit ${STEP_NOT_RUN}; }
[ "$code" = 200 ] || { cat "$tmp/out.tar" >&2; exit ${STEP_NOT_RUN}; }
exit_code=$(header ${STEP_HEADER.exit} "$tmp/head2")
problem=$(header ${STEP_HEADER.problem} "$tmp/head2")
sha=$(header ${STEP_HEADER.sha256} "$tmp/head2")
if [ -s "$tmp/out.tar" ] && [ -n "$sha" ]; then
  # The outputs' sha256 as the box made it (issue #2288): checked here too, so a copy damaged on the way is never unpacked.
  echo "hopper-step: outputs sha256 $sha" >&2
  got=$(sha256sum < "$tmp/out.tar" 2>/dev/null) || got=
  got=\${got%% *}
  if [ -n "$got" ] && [ "$got" != "$sha" ]; then
    echo "hopper-step: the outputs came back damaged: their sha256 is $sha, here $got" >&2
    exit ${STEP_NOT_RUN}
  fi
fi
if [ -s "$tmp/out.tar" ]; then
  mkdir -p "$into" && tar -xf "$tmp/out.tar" -C "$into" && echo "hopper-step: outputs in $into" >&2 || problem=\${problem:-the outputs could not be unpacked into $into}
fi
echo "hopper-step: exit $exit_code" >&2
if [ -n "$problem" ]; then echo "hopper-step: $problem" >&2; exit ${STEP_NOT_RUN}; fi
exit "\${exit_code:-${STEP_NOT_RUN}}"
`;
