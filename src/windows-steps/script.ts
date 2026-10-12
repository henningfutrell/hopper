// `hopper-step` (issue #731): the command a job runs to have the hopper run one step on a Windows host — a .NET
// Framework build, a Windows app's tests, a packing step — and get its log, its exit code and its outputs back. Kept in
// the job's credentials dir beside its proxy token, `hopper-gh` and `hopper-skill`, run as `sh "$HOPPER_STEP"`: POSIX
// sh, curl, tar and od, nothing else. Its full help is the `windows-step` skill's text.

export const STEP_SCRIPT_VARIABLE = 'HOPPER_STEP';

/** The routes on the hopper's URL a job's step requests go to. */
export const STEP_PATH = '/job/step';

/** The file under the job's credentials dir. */
export const STEP_SCRIPT_FILE = 'hopper/step';

/** The response headers: the step's id on the run, its exit code and the hopper's problem on the result. */
export const STEP_HEADER = { id: 'x-hopper-step', exit: 'x-hopper-step-exit', problem: 'x-hopper-step-problem' } as const;

/** The exit code the script ends with when the hopper did not run the step, or could not bring it all back. */
export const STEP_NOT_RUN = 125;

/** Where `--script FILE` goes in the inputs: the step's scratch directory on the host, removed after the step. */
export const STEP_SCRIPT_INPUT = '.hopper-step/script.ps1';

/** What a job reads when it loads the `windows-step` skill. */
export const STEP_HELP = `windows-step: run one step on a Windows host, from this Linux machine.

No agent, client or work tree runs on Windows. When the work needs Windows (a .NET Framework build, a Windows app's
tests, a packing step), the hopper runs that one step on a Windows host a person set up, over ssh, in PowerShell, in
that host's working directory. The step's output streams back here as it runs; then its exit code and its outputs.

  sh "$HOPPER_STEP" hosts                     the Windows hosts: name, working directory, label, the secrets it gives
  sh "$HOPPER_STEP" run HOST (--command TEXT | --script FILE) [--input PATH]... [--output PATH]...
                         [--secret NAME]... [--timeout SECONDS] [--into DIR]
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
Exit: the step's own exit code; ${STEP_NOT_RUN}: the hopper did not run it, stopped it, or could not bring it all back
(the reason is on stderr); 2: a bad call.

One step runs on a host at a time: a step waits while another runs there, and says so. The host keeps no scratch:
the hopper removes what it copied there for the step when the step ends. Inputs overwrite files of the same name in
the working directory, and stay there. A step is on this job's timeline: its host, command, exit code and time.
The step gets no GitHub token and no credential but the vault secrets it asks for with --secret. GitHub stays here:
fetch, push and open pull requests from this machine. Do not print a secret, or write it into an output: the hopper
masks only the log.

Example: build a solution on the host, and bring the build back.
  sh "$HOPPER_STEP" run build-host --input src --command "msbuild App.sln /p:Configuration=Release" --output src/App/bin/Release --into out
Example: push a package with a key from the vault.
  sh "$HOPPER_STEP" run build-host --secret NUGET_TOKEN --command 'nuget push out\\App.nupkg -ApiKey $env:NUGET_TOKEN'`;

/** The script. The token goes to curl on stdin, never on a command line; every value in a URL is percent-encoded. */
export const STEP_SCRIPT = `#!/bin/sh
# hopper-step — run one step on a Windows host (issue #731). Written by the hopper at each job start.
#   sh "$HOPPER_STEP" hosts
#   sh "$HOPPER_STEP" run HOST (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--secret NAME]... [--timeout SECONDS] [--into DIR]
# Load the windows-step skill for the full help: sh "$HOPPER_SKILL" windows-step
# Exit: the step's own exit code; ${STEP_NOT_RUN}: the hopper did not run it, stopped it, or could not bring it all back; 2: a bad call.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_STEP" hosts | run HOST (--command TEXT | --script FILE) [--input PATH]... [--output PATH]... [--secret NAME]... [--timeout SECONDS] [--into DIR]' >&2; exit 2; }
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; }
# Every byte as %XX: safe in a URL whatever the text holds.
enc() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \\n' | sed 's/../%&/g'; }
# A response header's value, from a header dump.
header() { awk -v h="$1:" 'tolower($1) == h { sub(/^[^:]*:[ ]*/, ""); sub(/\\r$/, ""); v = $0 } END { print v }' "$2"; }
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
[ "$cmd" = run ] && [ $# -ge 1 ] || usage
host=$1; shift
command=; script=; into=.; q=; : > "$tmp/inputs"
while [ $# -gt 0 ]; do
  case $1 in
    --command|--script|--input|--output|--secret|--timeout|--into)
      [ $# -ge 2 ] || usage
      case $1 in
        --command) command=$2 ;;
        --script) script=$2 ;;
        --input) [ -e "$2" ] || { echo "no: $2 is not here" >&2; exit 2; }; printf '%s\\n' "$2" >> "$tmp/inputs" ;;
        --output) q="$q&output=$(enc "$2")" ;;
        --secret) q="$q&secret=$(enc "$2")" ;;
        --timeout) q="$q&timeout=$(enc "$2")" ;;
        --into) into=$2 ;;
      esac
      shift ;;
    *) usage ;;
  esac
  shift
done
if [ -n "$script" ]; then
  [ -z "$command" ] || { echo 'no: give --command or --script, not both' >&2; exit 2; }
  [ -f "$script" ] && [ -r "$script" ] || { echo "no: $script is not a file this job can read" >&2; exit 2; }
  mkdir -p "$tmp/s/.hopper-step" && cp "$script" "$tmp/s/${STEP_SCRIPT_INPUT}" || exit ${STEP_NOT_RUN}
  command="& '.\\\\.hopper-step\\\\script.ps1'"
fi
[ -n "$command" ] || usage
if [ -s "$tmp/inputs" ] || [ -n "$script" ]; then
  set --
  [ -s "$tmp/inputs" ] && set -- "$@" -T "$tmp/inputs"
  [ -n "$script" ] && set -- "$@" -C "$tmp/s" ${STEP_SCRIPT_INPUT}
  tar -cf "$tmp/in.tar" "$@" || { echo 'no: the inputs could not be packed' >&2; exit ${STEP_NOT_RUN}; }
else
  : > "$tmp/in.tar"
fi
# The step's output streams to stdout as it comes; its id is in the response's header.
token | curl -sS -N -H @- -H 'expect:' -H 'content-type: application/x-tar' --data-binary @"$tmp/in.tar" -D "$tmp/head" \\
  "$HOPPER_URL${STEP_PATH}?host=$(enc "$host")&command=$(enc "$command")$q" || { echo 'hopper-step: the hopper could not be reached, or the connection broke' >&2; exit ${STEP_NOT_RUN}; }
status=$(awk '/^HTTP\\// { s = $2 } END { print s }' "$tmp/head")
[ "$status" = 200 ] || exit ${STEP_NOT_RUN}
id=$(header ${STEP_HEADER.id} "$tmp/head")
code=$(token | curl -sS -H @- -D "$tmp/head2" -o "$tmp/out.tar" -w '%{http_code}' "$HOPPER_URL${STEP_PATH}/$id") || exit ${STEP_NOT_RUN}
[ "$code" = 200 ] || { cat "$tmp/out.tar" >&2; exit ${STEP_NOT_RUN}; }
exit_code=$(header ${STEP_HEADER.exit} "$tmp/head2")
problem=$(header ${STEP_HEADER.problem} "$tmp/head2")
if [ -s "$tmp/out.tar" ]; then
  mkdir -p "$into" && tar -xf "$tmp/out.tar" -C "$into" && echo "hopper-step: outputs in $into" >&2 || problem=\${problem:-the outputs could not be unpacked into $into}
fi
echo "hopper-step: exit $exit_code" >&2
if [ -n "$problem" ]; then echo "hopper-step: $problem" >&2; exit ${STEP_NOT_RUN}; fi
exit "\${exit_code:-${STEP_NOT_RUN}}"
`;
