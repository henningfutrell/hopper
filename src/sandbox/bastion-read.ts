// A bastion read (issue #2146, design.md "Bastions", part 6): one HTTP read of a bastion's target, run in the bastion's
// box with a vault secret that stays there. A Grafana Viewer token is the case: the relay's commands run where the job
// runs, which gets no vault secret, so the hopper runs `curl` in the box for the job, with the secret's Authorization
// header from its file (never on a command line, never in the box's environment), and answers the body. A GET of any
// path, or a POST to Grafana's data source query (`/api/ds/query`, a read); nothing else. Read-only past that is the
// target's own credential (a Viewer token). The connection is the relay's: Access decides it, and it renews the TTL.
import { VAULT_SECRET_NAME } from '../domain/vault.ts';
import { HOME } from './flags.ts';

/** The most of an answer the hopper takes: a bigger one is refused, so the job narrows its query. */
export const READ_MAX_BYTES = 2 * 1024 * 1024;
/** The most a POST's JSON body is. */
export const READ_DATA_MAX = 64 * 1024;
/** How long one read may take in the box. */
export const READ_TIMEOUT_S = 30;
/** The paths a POST may go to: Grafana's data source query, which reads. */
export const READ_POSTS = ['/api/ds/query'];

/** A read as the job asks for it: one of its bastion's targets, a path, the vault secret for its header, a POST's body. */
export interface BastionReadAsk { target: string; path: string; secret?: string; data?: string }
/** A read the hopper runs. */
export interface BastionRead extends BastionReadAsk { method: 'GET' | 'POST' }

/** A path: from `/`, printable ASCII with no space, `#` or `\`, at most 4096 characters. */
const PATH = /^\/[!-~]{0,4095}$/;

/** The read the job asks for, or why it cannot be run. */
export function parseRead(a: { target?: string; path?: string; secret?: string; data?: string }): BastionRead | string {
  if (!a.target || /\s/.test(a.target)) return 'name one target of the bastion with --targets';
  if (!a.path) return 'name the path to read with --path, for example "/api/search?query=latency"';
  if (!PATH.test(a.path) || /[#\\]/.test(a.path)) return `${a.path.slice(0, 80)}: a path starts with / and holds printable characters only, with no space, # or \\`;
  if (a.secret !== undefined && !VAULT_SECRET_NAME.test(a.secret)) return `${a.secret}: no vault secret name`;
  if (a.data === undefined) return { target: a.target, path: a.path, method: 'GET', ...(a.secret ? { secret: a.secret } : {}) };
  const at = a.path.split('?')[0]!;
  if (!READ_POSTS.includes(at)) return `a read POSTs only to ${READ_POSTS.join(', ')} (a data source query); ${at} is read with a GET`;
  if (Buffer.byteLength(a.data) > READ_DATA_MAX) return `--data is at most ${READ_DATA_MAX} bytes`;
  try { JSON.parse(a.data); } catch { return '--data is a JSON body'; }
  return { target: a.target, path: a.path, method: 'POST', data: a.data, ...(a.secret ? { secret: a.secret } : {}) };
}

/** The file in the box that holds a vault secret's header for reads: `$HOME/.hopper-need/secrets/read-<name>`. */
export const readSecretName = (secret: string): string => `read-${secret}`;
/** The header line curl reads from that file. */
export const readHeader = (value: string): string => `Authorization: Bearer ${value.trim()}\n`;

/**
 * The command the hopper starts in the box for one read: curl to 127.0.0.1:`local` and the path, the header from the
 * secret's file, a POST's body on its stdin, no proxy. Its stdout: the body, a new line, and the HTTP status. Exit 127:
 * the box's image has no curl.
 */
export const readCommand = (local: number, r: Pick<BastionRead, 'method' | 'path' | 'secret'>): string[] =>
  ['sh', '-c', READ_SH, 'hopper-bastion-read', String(local), r.method, r.path, r.secret ? `${HOME}/.hopper-need/secrets/${readSecretName(r.secret)}` : ''];

export const READ_SH = `command -v curl >/dev/null 2>&1 || { echo "hopper-bastion-read: the box's image has no curl" >&2; exit 127; }
p=$1 m=$2 path=$3 h=$4
set -- -sS --globoff --noproxy '*' --max-time ${READ_TIMEOUT_S} -o - -w '\\n%{http_code}' -X "$m"
[ -z "$h" ] || set -- "$@" -H "@$h"
if [ "$m" = POST ]; then set -- "$@" -H 'Content-Type: application/json' --data-binary @-; fi
exec curl "$@" "http://127.0.0.1:$p$path"`;

/** The answer of a read's command: the HTTP status and the body; or why there is none (curl's own words). */
export function readAnswer(stdout: Buffer, stderr: string): { status: number; body: Buffer } | { problem: string } {
  const nl = stdout.lastIndexOf(0x0a);
  const code = nl >= 0 ? Number(stdout.subarray(nl + 1).toString()) : NaN;
  if (!Number.isInteger(code) || code < 100) return { problem: stderr.trim().split('\n').slice(-3).join(' ') || 'the read in the box gave no answer' };
  return { status: code, body: stdout.subarray(0, nl) };
}
