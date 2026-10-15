// A job's scripts wait on the job stream (issue #613): `hopper-skill --wait` (issue #582) and `hopper-gh pr wait`
// (issue #1072 part 2) ask once, and when the hopper opens a watch they read the stream of that request until it ends,
// reconnecting with Last-Event-ID when it drops, until the watch's deadline. POSIX sh, curl and awk: text for a script.
import { STREAM_PATH } from './wire.ts';

/**
 * Reads a saved job stream (the SSE text of one request): prints the last event id seen, then the request's ending
 * phase and the pointer's URL when its event is one; writes its payload to the file \`out\` names, a JSON string decoded.
 * No single quote: the script passes it in one.
 */
export const STREAM_AWK = String.raw`
function hexval(h,   i, n) { n = 0; for (i = 1; i <= 4; i++) n = n * 16 + index("0123456789abcdef", tolower(substr(h, i, 1))) - 1; return n }
function unjson(s,   o, i, c, n) {
  o = ""; n = length(s)
  for (i = 1; i <= n; i++) {
    c = substr(s, i, 1)
    if (c != "\\") { o = o c; continue }
    c = substr(s, ++i, 1)
    if (c == "n") o = o "\n"; else if (c == "t") o = o "\t"; else if (c == "r") o = o "\r"
    else if (c == "b") o = o "\b"; else if (c == "f") o = o "\f"
    else if (c == "u") { o = o sprintf("%c", hexval(substr(s, i + 1, 4))); i += 4 }
    else o = o c
  }
  return o
}
/^id: / { last = substr($0, 5) }
/^data: / {
  line = substr($0, 7); p = ""
  if (index(line, "\"phase\":\"done\"")) p = "done"
  else if (index(line, "\"phase\":\"failed\"")) p = "failed"
  else if (index(line, "\"phase\":\"expired\"")) p = "expired"
  if (p == "") next
  phase = p
  i = index(line, "\"ref\":{\"url\":\"")
  if (i) { r = substr(line, i + 14); ref = substr(r, 1, index(r, "\"") - 1); next }
  v = substr(line, index(line, "\"payload\":") + 10); v = substr(v, 1, length(v) - 1)
  if (substr(v, 1, 1) == "\"") v = unjson(substr(v, 2, length(v) - 2))
  printf "%s", v > out
}
END { print last, phase, ref }
`;

/**
 * \`stream_wait ID SECONDS\`: reads the stream of request ID until the hopper ends it, at most SECONDS (and 5 s more for
 * the hopper's own end); prints its ending payload, a pointer's fetched. Returns 0 done, 1 failed or a refused token, 4
 * expired. The script defines \`token\` and \`hcurl\` (retry-after.ts), calls it last, and its EXIT trap removes the files.
 */
export const STREAM_WAIT_SH = `stream_wait() {
  _sid=$1
  _sends=$(( $(date +%s) + $2 + 5 ))
  _sdir=$(mktemp -d "\${TMPDIR:-/tmp}/hopper-stream.XXXXXX") || return 1
  trap 'rm -rf "$_sdir"' EXIT
  _slast=0
  while :; do
    _sleft=$(( _sends - $(date +%s) ))
    if [ "$_sleft" -le 0 ]; then echo 'expired: no answer came before the wait ended. Go on without it, or ask again to wait longer.'; return 4; fi
    # The stream of this request alone: the hopper ends it after the request's last event.
    _scode=$( (token; printf 'last-event-id: %s\\naccept: text/event-stream\\n' "$_slast") | curl -sSN -H @- --max-time "$_sleft" -o "$_sdir/s" -w '%{http_code}' "$HOPPER_URL${STREAM_PATH}?request=$_sid" 2>/dev/null)
    case $_scode in
      200) ;;
      401|403|404) cat "$_sdir/s"; return 1 ;;
      *) sleep 1; continue ;;
    esac
    # The last event id seen, then the request's end: its phase, and its payload (into $_sdir/out) or a pointer to it.
    set -- $(awk -v out="$_sdir/out" -v last="$_slast" '${STREAM_AWK}' "$_sdir/s")
    [ -n "$1" ] && _slast=$1
    case $2 in
      '') sleep 1; continue ;;
      done) _sstatus=0 ;;
      expired) _sstatus=4 ;;
      *) _sstatus=1 ;;
    esac
    if [ -n "$3" ]; then
      hcurl -sS -H @- -H 'accept: text/plain' "$HOPPER_URL$3" > "$_sdir/out" || return 1
    fi
    printf '%s' "$(cat "$_sdir/out")"
    return "$_sstatus"
  done
}`;
