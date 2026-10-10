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
export const ARTIFACT_HELP = `artifacts: put a visual on the hopper for a person to see — a diagram, a chart, a graph, a map, a table of data drawn.

An artifact is a visual. Use one for a diagram (flow, sequence, state, architecture), a chart or a graph.
Prose goes in the issue comment or the job result, not in an artifact: a page of styled text is not an artifact.
Keep the words in an artifact to labels and short captions.

The hopper keeps it with this job and its issue, and gives a URL. A person sees it on the job's card and in Artifacts,
often on a phone: give the drawing a viewBox and no fixed width, so it scales.

Draw it self-contained: inline SVG, or a <canvas> with an inline script. No external loads: no script, style, font
or image from another address, and no fetch. HTML and SVG open in a sandbox where only what is in the file works.
An HTML artifact with no <svg>, <canvas> or <img> is kept, but the put warns that it has no visual, and the warning
is on the job's timeline.

  sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--type TYPE]   keep FILE; prints its id and URL, and a warning if any
        TYPE: html, svg, png, jpeg, gif, webp, pdf, csv, markdown, json, text or file (default: from FILE's name)
  sh "$HOPPER_ARTIFACT" list [--all] [--markdown]               this job's artifacts (--all: every job's of this user)
  sh "$HOPPER_ARTIFACT" get ID [--out FILE]                     its details, or its content into FILE
  sh "$HOPPER_ARTIFACT" share ID --user NAME                    let another user of this hopper see it
  sh "$HOPPER_ARTIFACT" share ID --public [--hours N]           a public link that expires (when the user allows them)
  sh "$HOPPER_ARTIFACT" share ID --revoke SHARE                 end a share; its link stops working at once
  sh "$HOPPER_ARTIFACT" rm ID                                   remove it, and every share of it
Add --json to any command for JSON. Exit 0: done; 1: a no, with why; 2: a bad call; 3: the hopper cannot be reached.

Example: a flow diagram, saved as flow.svg, then: sh "$HOPPER_ARTIFACT" put flow.svg --title "Intake flow"
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 460 90" font-family="sans-serif" font-size="13">
    <defs><marker id="a" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M0 0L10 5L0 10z"/></marker></defs>
    <g fill="#eef3ff" stroke="#3456a0">
      <rect x="10" y="25" width="110" height="40" rx="6"/><rect x="175" y="25" width="110" height="40" rx="6"/>
      <rect x="340" y="25" width="110" height="40" rx="6"/></g>
    <g text-anchor="middle"><text x="65" y="50">Issue</text><text x="230" y="50">Intake</text><text x="395" y="50">Job</text></g>
    <g stroke="#333" marker-end="url(#a)"><line x1="120" y1="45" x2="175" y2="45"/><line x1="285" y1="45" x2="340" y2="45"/></g>
    <text x="147" y="18" text-anchor="middle" font-size="11">labelled</text>
  </svg>

Example: a bar chart, saved as wait.svg, then: sh "$HOPPER_ARTIFACT" put wait.svg --title "Queue wait by hour"
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180" font-family="sans-serif" font-size="11">
    <line x1="40" y1="150" x2="310" y2="150" stroke="#333"/><line x1="40" y1="10" x2="40" y2="150" stroke="#333"/>
    <g fill="#3a7bd5"><rect x="55" y="90" width="40" height="60"/><rect x="120" y="40" width="40" height="110"/>
      <rect x="185" y="110" width="40" height="40"/><rect x="250" y="70" width="40" height="80"/></g>
    <g text-anchor="middle"><text x="75" y="165">08</text><text x="140" y="165">09</text><text x="205" y="165">10</text>
      <text x="270" y="165">11</text><text x="75" y="85">6 m</text><text x="140" y="35">11 m</text>
      <text x="205" y="105">4 m</text><text x="270" y="65">8 m</text></g>
  </svg>
For a sequence diagram: one vertical line per actor, one arrow per message, top to bottom in time order.
In HTML, put the same <svg> in the page; a short caption under it is enough.

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
