// `hopper-artifact` (issue #624): the command a job runs to put a file on the hopper for a person to see, and to list,
// get, share and remove its artifacts. Kept in the job's credentials dir beside its proxy token, `hopper-gh` and
// `hopper-skill`, run as `sh "$HOPPER_ARTIFACT"`: POSIX sh, curl and od, nothing else. Its full help is the
// `artifacts` skill's text: a job reads it only when it loads the skill. Agent-native: `--json` answers JSON, and the
// exit code says what happened.

import { ARTIFACT_LIB_PATH, ARTIFACT_LIBS } from './libs.ts';

export const ARTIFACT_SCRIPT_VARIABLE = 'HOPPER_ARTIFACT';

/** The routes on the hopper's URL a job's artifact requests go to. */
export const ARTIFACT_PATH = '/job/artifacts';

/** The file under the job's credentials dir. */
export const ARTIFACT_SCRIPT_FILE = 'hopper/artifact';

/** The exit codes: what a job reads. */
export const ARTIFACT_EXIT = { done: 0, no: 1, badCall: 2, unreachable: 3 } as const;

/** What a job reads when it loads the `artifacts` skill: every command, its options and its exit codes. */
export const ARTIFACT_HELP = `artifacts: present this job's work to people as a live page on the hopper.

An artifact is a presentation medium: a shareable, meaningful, dynamic page that shows the result itself.
Use a flowchart, a diagram, a chart, a map or an interactive view: pick the form that shows the result best.
A person opens it on a phone or a desktop, clicks, hovers, expands, filters and steps through it, and shares it.
Prose goes in the issue comment or the job result, not in an artifact. Keep words on the page to labels and captions.

Every artifact has a title and a one-line summary (--title, --summary). They show in lists, on the job card and in
share previews. A put with no summary is kept, with a warning.

Every change is a revision. Put a new file to an artifact (--to ID) to change it: the id and its links stay and show
the latest revision; the older revisions stay readable, and a person can restore one. Say what changed with --note.
Before you put, run \`list --all\`. If an artifact already shows this work, even one another job made, revise it with \`put FILE --to ID --note TEXT\`.
A put without --to that has the file name, the title prefix or an issue reference of an artifact you have is kept,
with a warning that names that artifact. Pass --new when it is new work.

The page runs in a sandbox: its inline scripts run, but it can reach nothing (no fetch, no hopper session) and load
nothing from outside. Put scripts, styles, images and fonts in the file. The hopper serves these libraries itself;
load them with a script tag and this path, as it is here:
${ARTIFACT_LIBS.map((l) => `  <script src="${ARTIFACT_LIB_PATH}/${l.file}"></script>   ${l.what} (global ${l.global})`).join('\n')}
No other script loads, and no eval or new Function. For a phone: <meta name="viewport" content="width=device-width">,
and give each drawing a viewBox or a width of 100%. An HTML page with no <svg>, <canvas>, <img> or <script> shows
nothing: it is kept, with a warning.

  sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--summary TEXT] [--type TYPE] [--new]
                                                                keep FILE as a new artifact; prints its id and URL
  sh "$HOPPER_ARTIFACT" put FILE --to ID [--note TEXT] [--title TEXT] [--summary TEXT]
                                                                FILE is the next revision of artifact ID
        TYPE: html, svg, png, jpeg, gif, webp, pdf, csv, markdown, json, text or file (default: from FILE's name)
  sh "$HOPPER_ARTIFACT" list [--all] [--markdown]               this job's artifacts (--all: every job's of this user)
  sh "$HOPPER_ARTIFACT" get ID [--out FILE]                     its details, or the latest content into FILE
  sh "$HOPPER_ARTIFACT" revisions ID                            its revisions, newest first: number, time, who, note
  sh "$HOPPER_ARTIFACT" restore ID N                            revision N is the latest again, as a new revision
  sh "$HOPPER_ARTIFACT" share ID --owner                        show it to its owner: posts its link on this job's issue
  sh "$HOPPER_ARTIFACT" share ID --user NAME                    let another user of this hopper see it
  sh "$HOPPER_ARTIFACT" share ID --public [--hours N]           a public link that expires (when the user allows them)
  sh "$HOPPER_ARTIFACT" share ID --revoke SHARE                 end a share; its link stops working at once
  sh "$HOPPER_ARTIFACT" rm ID                                   remove it, every revision and every share of it
Add --json to any command for JSON. Exit 0: done; 1: a no, with why; 2: a bad call; 3: the hopper cannot be reached.

Example: an interactive flowchart, saved as flow.html. Click a step to see its code.
  sh "$HOPPER_ARTIFACT" put flow.html --title "Intake flow" --summary "How an issue becomes a job"
  <!doctype html><meta name="viewport" content="width=device-width"><title>Intake flow</title>
  <script src="${ARTIFACT_LIB_PATH}/mermaid.js"></script>
  <pre class="mermaid">flowchart LR
    I[Issue] -->|labelled| S(Sync) --> J[Job]
    click S call show("src/sources/sync.ts: reads the issue")
    click J call show("src/engine/source-host.ts: makes the job")</pre>
  <p id="code">Click a step.</p>
  <script>
    window.show = (t) => { document.getElementById('code').textContent = t; };
    mermaid.initialize({ startOnLoad: true, securityLevel: 'loose' });
  </script>

Example: a chart a person can filter, saved as wait.html.
  sh "$HOPPER_ARTIFACT" put wait.html --title "Queue wait" --summary "Wait by hour; longest at nine"
  <!doctype html><meta name="viewport" content="width=device-width"><title>Queue wait</title>
  <script src="${ARTIFACT_LIB_PATH}/chart.js"></script>
  <label><input type="checkbox" id="high" checked> high priority</label>
  <canvas id="c"></canvas>
  <script>
    const all = { labels: ['08', '09', '10', '11'], high: [2, 5, 1, 3], normal: [6, 11, 4, 8] };
    const high = document.getElementById('high');
    const sets = () => [{ label: 'normal', data: all.normal }].concat(high.checked ? [{ label: 'high', data: all.high }] : []);
    const chart = new Chart(document.getElementById('c'), { type: 'bar', data: { labels: all.labels, datasets: sets() } });
    high.onchange = () => { chart.data.datasets = sets(); chart.update(); };
  </script>

Then show it: in a proposal or a research report, put the artifact's URL on a line: the hopper shows the artifact
there. share --owner (or --user with their name) makes no share, because the owner sees it already: it posts the
artifact's link on the job's issue, as this job's comment. An issue whose deliverable is an artifact is done when that
comment is there; no pull request is needed.
On GitHub (a pull request body, an issue comment): link an artifact only by a URL list --markdown gives. It gives one
only when the hopper has a public URL; else name the artifact by its title, and say it is on the hopper. A link to
one revision ends /N after the artifact's id.
Text artifacts are checked for GitHub tokens: one found is masked before the hopper keeps it.`;

/** The script. The token goes to curl on stdin, never on a command line; every value in a URL is percent-encoded. */
export const ARTIFACT_SCRIPT = `#!/bin/sh
# hopper-artifact — put files on the hopper for a person to see (issue #624). Written by the hopper at each job start.
#   sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--summary TEXT] [--type TYPE] [--to ID [--note TEXT] | --new]
#   sh "$HOPPER_ARTIFACT" list [--all] [--markdown] | get ID [--out FILE] | revisions ID | restore ID N
#   sh "$HOPPER_ARTIFACT" share ID (--owner | --user NAME | --public [--hours N] | --revoke SHARE) | rm ID     [--json]
# Load the artifacts skill for the full help: sh "$HOPPER_SKILL" artifacts
# Exit 0: done; 1: a no, with why; 2: a bad call; 3: the hopper cannot be reached.
: "\${HOPPER_URL:?HOPPER_URL is not set: the hopper cannot be reached from here}"
: "\${HOPPER_TOKEN_FILE:?HOPPER_TOKEN_FILE is not set}"
usage() { echo 'usage: sh "$HOPPER_ARTIFACT" put FILE [--title TEXT] [--summary TEXT] [--type TYPE] [--to ID [--note TEXT] | --new] | list [--all] [--markdown] | get ID [--out FILE] | revisions ID | restore ID N | share ID (--owner | --user NAME | --public [--hours N] | --revoke SHARE) | rm ID  [--json]' >&2; exit 2; }
token() { printf 'authorization: Bearer %s\\n' "$(cat "$HOPPER_TOKEN_FILE")"; [ -z "$json" ] || printf 'accept: application/json\\n'; }
# Every byte as %XX: safe in a URL whatever the text holds.
enc() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \\n' | sed 's/../%&/g'; }
[ $# -ge 1 ] || usage
cmd=$1; shift
id=; file=; out=; json=; q=; n=
case $cmd in
  put) [ $# -ge 1 ] || usage; file=$1; shift ;;
  get|share|rm|revisions|restore) [ $# -ge 1 ] || usage; id=$1; shift
       case $id in *[!A-Za-z0-9-]*|'') echo "no: $id is not an artifact id" >&2; exit 2 ;; esac
       if [ "$cmd" = restore ]; then
         [ $# -ge 1 ] || usage; n=$1; shift
         case $n in *[!0-9]*|''|0*) echo "no: $n is not a revision number" >&2; exit 2 ;; esac
       fi ;;
  list) ;;
  *) usage ;;
esac
while [ $# -gt 0 ]; do
  case $1 in
    --json) json=1 ;;
    --all) q="$q&all=1" ;;
    --markdown) q="$q&markdown=1" ;;
    --public) q="$q&public=1" ;;
    --owner) q="$q&owner=1" ;;
    --new) q="$q&new=1" ;;
    --title|--summary|--type|--to|--note|--user|--hours|--revoke|--out)
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
  revisions) res=$(token | curl -sS -H @- -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}/$id/revisions") || exit 3 ;;
  restore) res=$(token | curl -sS -H @- -X POST -w '\\n%{http_code}' "$HOPPER_URL${ARTIFACT_PATH}/$id/restore?revision=$n") || exit 3 ;;
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
