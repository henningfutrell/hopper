// The reach check (issue #695, design.md "GitHub through the hopper" → "The reach check"): before a job starts, the
// hopper asks the job's machine whether it reaches the hopper at the URL the job is given — the fixed script here, run
// through the machine's own connection: this machine, over ssh, or as a client target's `POST /reach`. It is curl,
// which hopper-gh, hopper-skill and hopper-artifact use too. Any answer of the hopper's is a reach, a refusal of a
// request without a token included; a name that does not resolve, a refused address (421) or a proxy whose hopper does
// not answer (5xx) is not. Imports nothing of hopper but its own directory: it is installed as plain files.

/** The route the check asks for: the job stream, which answers 401 without a job's token, and changes nothing. */
const PATH = '/job/stream';

// $1 the hopper's URL. Prints `hopper-reach <HTTP status>` (000: no answer), curl's own error on stderr.
const REACH_SCRIPT = [
  'u=$1; command -v curl >/dev/null 2>&1 || { echo hopper-reach no-curl; exit 127; };',
  `curl -sS -o /dev/null --connect-timeout 5 --max-time 10 -w 'hopper-reach %{http_code}\\n' "$u${PATH}"`,
].join(' ');

/** How long the check may take, at most: curl gives up after 10 s. */
export const REACH_TIMEOUT_MS = 20000;

/** A URL the check may be asked for: http or https, one line, short. */
export const isReachUrl = (url: unknown): url is string => {
  if (typeof url !== 'string' || url.length > 2048 || /[\s\0]/.test(url)) return false;
  try { return /^https?:$/.test(new URL(url).protocol); } catch { return false; }
};

/** The argv that checks from this machine that it reaches the hopper at `url`. */
export const reachArgv = (url: string): string[] => ['sh', '-c', REACH_SCRIPT, 'sh', url.replace(/\/+$/, '')];

/** The argv a client's `POST /reach {url}` asks for; else why it is refused. */
export const reachOf = (body: unknown): string[] | string => {
  const url = (typeof body === 'object' && body !== null ? body : {}) as { url?: unknown };
  return isReachUrl(url.url) ? reachArgv(url.url) : 'url must be an http or https URL';
};

/** What the check said: undefined when the machine reaches the hopper at `url`, else why not, plainly. */
export function readReach(r: { code: number; stdout: string; stderr: string }, url: string): string | undefined {
  const not = `this machine cannot reach the hopper at ${url}`;
  const said = /^hopper-reach (\S+)$/m.exec(r.stdout)?.[1];
  if (r.code === 127 || said === 'no-curl') return `${not}: curl is not on this machine (the job's tools need it)`;
  const status = said === undefined ? 0 : Number(said);
  if (r.code !== 0 || !status) {
    const why = r.stderr.trim().split('\n').pop()?.replace(/^curl: \(\d+\) /, '').slice(0, 300);
    return `${not}: ${why || `the check ended with exit ${r.code}`}`;
  }
  if (status === 421) return `${not}: it refused the address (421): the hopper does not take it as one of its names`;
  if (status >= 500) return `${not}: it answered ${status}: what answers there is not the hopper, or the hopper behind it does not answer`;
  return undefined;
}
