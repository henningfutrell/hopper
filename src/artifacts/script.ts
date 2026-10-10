// `hopper-artifact` (issue #624): the command a job runs to put a file on the hopper for a person to see, and to list,
// get, share and remove its artifacts. Kept in the job's credentials dir beside its proxy token, `hopper-gh` and
// `hopper-skill`, run as `sh "$HOPPER_ARTIFACT"`: POSIX sh, curl and od, nothing else. Its full help is the
// `artifacts` skill's text: a job reads it only when it loads the skill. Agent-native: `--json` answers JSON, and the
// exit code says what happened.

export const ARTIFACT_SCRIPT_VARIABLE = 'HOPPER_ARTIFACT';

/** The routes on the hopper's URL a job's artifact requests go to. */
export const ARTIFACT_PATH = '/job/artifacts';

/** The file under the job's credentials dir. */
export const ARTIFACT_SCRIPT_FILE = 'hopper/artifact';

/** The exit codes: what a job reads. */
export const ARTIFACT_EXIT = { done: 0, no: 1, badCall: 2, unreachable: 3 } as const;

/** What a job reads when it loads the `artifacts` skill: every command, its options and its exit codes. */
export const ARTIFACT_HELP = `artifacts: put a file on the hopper for a person to see — a chart, an HTML page, a report, an image, a CSV.

The hopper keeps it with this job and its issue, and gives a URL. A person sees it on the job's card and in Artifacts.
HTML opens in a sandbox: its scripts run, but it can reach nothing (no fetch, no hopper session). Make it self-contained;
scripts and styles from an https: CDN load.

  sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--type TYPE]   keep FILE; prints its id and URL
        TYPE: html, svg, png, jpeg, gif, webp, pdf, csv, markdown, json, text or file (default: from FILE's name)
  sh "$HOPPER_ARTIFACT" list [--all] [--markdown]               this job's artifacts (--all: every job's of this user)
  sh "$HOPPER_ARTIFACT" get ID [--out FILE]                     its details, or its content into FILE
  sh "$HOPPER_ARTIFACT" share ID --user NAME                    let another user of this hopper see it
  sh "$HOPPER_ARTIFACT" share ID --public [--hours N]           a public link that expires (when the user allows them)
  sh "$HOPPER_ARTIFACT" share ID --revoke SHARE                 end a share; its link stops working at once
  sh "$HOPPER_ARTIFACT" rm ID                                   remove it, and every share of it
Add --json to any command for JSON. Exit 0: done; 1: a no, with why; 2: a bad call; 3: the hopper cannot be reached.

In a proposal or a research report, put the artifact's URL on a line: the hopper shows the artifact there.
On GitHub (a pull request body, an issue comment): link an artifact only by a URL list --markdown gives. It gives one
only when the hopper has a public URL; else name the artifact by its title, and say it is on the hopper.
Text artifacts are checked for GitHub tokens: one found is masked before the hopper keeps it.`;

/** The script. The token goes to curl on stdin, never on a command line; every value in a URL is percent-encoded. */
export const ARTIFACT_SCRIPT = `#!/bin/sh
# hopper-artifact — put files on the hopper for a person to see (issue #624). Written by the hopper at each job start.
#   sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--type TYPE] | list [--all] [--markdown] | get ID [--out FILE]
#   sh "$HOPPER_ARTIFACT" share ID (--user NAME | --public [--hours N] | --revoke SHARE) | rm ID     [--json]
# Load the artifacts skill for the full help: sh "$HOPPER_SKILL" artifacts
# Exit 0: done; 1: a no, with why; 2: a bad call; 3: the hopper cannot be reached.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--type TYPE] | list [--all] [--markdown] | get ID [--out FILE] | share ID (--user NAME | --public [--hours N] | --revoke SHARE) | rm ID  [--json]' >&2; exit 2; }
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; [ -z "$json" ] || printf 'accept: application/json\\n'; }
# Every byte as %XX: safe in a URL whatever the text holds.
enc() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \\n' | sed 's/../%&/g'; }
[ $# -ge 1 ] || usage
cmd=$1; shift
id=; file=; out=; json=; q=
case $cmd in
  put) [ $# -ge 1 ] || usage; file=$1; shift ;;
  get|share|rm) [ $# -ge 1 ] || usage; id=$1; shift
       case $id in *[!A-Za-z0-9-]*|'') echo "no: $id is not an artifact id" >&2; exit 2 ;; esac ;;
  list) ;;
  *) usage ;;
esac
while [ $# -gt 0 ]; do
  case $1 in
    --json) json=1 ;;
    --all) q="$q&all=1" ;;
    --markdown) q="$q&markdown=1" ;;
    --public) q="$q&public=1" ;;
    --title|--type|--user|--hours|--revoke|--out)
      [ $# -ge 2 ] || usage
      case $1 in --out) out=$2 ;; *) q="$q&\${1#--}=$(enc "$2")" ;; esac
      shift ;;
    *) usage ;;
  esac
  shift
done
case $cmd in
  put)
    [ -f "$file" ] && [ -r "$file" ] || { echo "no: $file is not a file this job can read" >&2; exit 2; }
    res=$(token | curl -sS -H @- -X POST -H 'content-type: application/octet-stream' --data-binary @"$file" -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}?name=$(enc "\${file##*/}")$q") || exit 3 ;;
  list) res=$(token | curl -sS -H @- -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}?$q") || exit 3 ;;
  get)
    if [ -n "$out" ]; then
      code=$(token | curl -sS -H @- -o "$out" -w '%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}/$id?content=1") || exit 3
      [ "$code" = 200 ] && { [ -n "$json" ] && printf '{"ok":true,"out":"%s"}\\n' "$out" || echo "wrote $out"; exit 0; }
      cat "$out"; rm -f "$out"; exit 1
    fi
    res=$(token | curl -sS -H @- -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}/$id") || exit 3 ;;
  share) res=$(token | curl -sS -H @- -X POST -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}/$id/share?$q") || exit 3 ;;
  rm) res=$(token | curl -sS -H @- -X POST -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}/$id/rm") || exit 3 ;;
esac
code=\${res##*
}
body=\${res%
*}
printf '%s' "$body"
case $code in
  2??) exit 0 ;;
  *) exit 1 ;;
esac
`;
