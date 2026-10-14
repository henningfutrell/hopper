// A job's scripts obey Retry-After (issue #752): while the hopper is out of reach, the client door holds a job's request,
// then answers 503 with Retry-After (src/client/door.ts). hopper-gh, hopper-skill and hopper-artifact send their request
// through `hcurl`, the shell function here: it waits as such an answer asks and sends the request again, a few times. Not
// curl's own --retry: that sends a 500 or a 502 again too, and a write the hopper may have done must not go twice. A 503
// with Retry-After is the door's (the hopper never got the request) or the job stream's "subscribe again in a moment".

/** How many times a script sends a request in all, while the answer is a 503 with Retry-After. */
export const RETRY_AFTER_TRIES = 4;
/** The longest wait a script takes from one Retry-After, in seconds. */
const RETRY_AFTER_MAX_S = 60;

/**
 * `hcurl CURL-ARGS…`: `token | curl -D <headers> CURL-ARGS…`, its output printed and curl's exit code returned, sent
 * again on a 503 with Retry-After. The script defines `token` (it prints the job's authorization header for `-H @-`).
 * Text for a script: its `$` and backslashes are the shell's.
 */
export const HCURL_SH = `hcurl() {
  _hh=$(mktemp "\${TMPDIR:-/tmp}/hopper-h.XXXXXX") || return 1
  _ht=1
  while :; do
    token | curl -D "$_hh" "$@" > "$_hh.out"; _hrc=$?
    _hw=$(tr -d '\\r' < "$_hh" | sed -n 's/^[Rr][Ee][Tt][Rr][Yy]-[Aa][Ff][Tt][Ee][Rr]: *\\([0-9][0-9]*\\)$/\\1/p' | tail -n 1)
    _hs=$(sed -n 's/^HTTP\\/[0-9.]* \\([0-9][0-9]*\\).*/\\1/p' "$_hh" | tail -n 1)
    if [ "$_hs" != 503 ] || [ -z "$_hw" ] || [ "$_ht" -ge ${RETRY_AFTER_TRIES} ]; then break; fi
    [ "$_hw" -le ${RETRY_AFTER_MAX_S} ] || _hw=${RETRY_AFTER_MAX_S}
    echo "hopper: the hopper asks to wait (503); trying again in $_hw s" >&2
    sleep "$_hw"; _ht=$((_ht + 1))
  done
  cat "$_hh.out"; rm -f "$_hh" "$_hh.out"
  return "$_hrc"
}`;
