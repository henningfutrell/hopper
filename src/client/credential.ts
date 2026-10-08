// A running job's credentials on a client target's machine (issue #441, design.md "Keeping the connection"):
// the fixed script the hopper's `keepCredential` runs here — this machine, over ssh, or as a client target's
// `POST /credential`. A job's connection's token is kept current in a file of its own on its machine, so a
// renewal reaches the jobs already running: the file is replaced whole (written beside, then moved), mode
// 600, only ever under the job's own credentials dir. The content comes on stdin, never as an argument a
// process list shows. Imports nothing of hopper but its own directory: it is installed as plain files.
import { isJobId } from './server.ts';

export const CREDENTIAL_KEPT = 'hopper-credential-kept';

// $1 the job id, $2 its credentials dir, $3 the file under it, $4 `make` when the work tree may be made
// here (the jobs dir), else empty: a work tree that is not there is the job's to refuse, never made by this.
// The content on stdin.
const CREDENTIAL_SCRIPT = [
  'id=$1; d=$2; f=$3; mk=$4;',
  'case $d in /*/.hopper-scratch/"$id"/credentials) ;; *) echo "not the job\'s credentials dir: $d" >&2; exit 2;; esac;',
  'case /$f/ in */../*|*/./*|//*) echo "not a file under it: $f" >&2; exit 2;; esac;',
  'w=${d%/.hopper-scratch/*}; if [ ! -d "$w" ] && [ "$mk" != make ]; then echo "the work tree $w is not there" >&2; exit 3; fi;',
  'umask 077; mkdir -p "$(dirname "$d/$f")" && cat > "$d/$f.new" && mv -f "$d/$f.new" "$d/$f" && printf "%s\\n" hopper-credential-kept',
].join(' ');

/** A credentials dir a job's credential may be kept in: absolute, one line, and the job's own. */
export const isCredentialsDirOf = (path: unknown, jobId: string): path is string =>
  typeof path === 'string' && path.startsWith('/') && !/[\n\0]/.test(path) && path.endsWith(`/.hopper-scratch/${jobId}/credentials`);

/** A file under it: a relative path of plain names, no `.` or `..`. */
export const isCredentialFile = (file: unknown): file is string =>
  typeof file === 'string' && file.length <= 255 && /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/.test(file) && !file.split('/').some((p) => p === '.' || p === '..');

/** The argv that keeps one credential file of a job; its content goes on stdin. */
export const credentialArgv = (jobId: string, dir: string, file: string, make = false): string[] => ['sh', '-c', CREDENTIAL_SCRIPT, 'sh', jobId, dir, file, make ? 'make' : ''];

/** The argv and stdin a `/credential` body asks for; else why it is refused. */
export function credentialOf(body: unknown): { argv: string[]; input: string } | string {
  const b = (typeof body === 'object' && body !== null ? body : {}) as { jobId?: unknown; dir?: unknown; file?: unknown; content?: unknown; make?: unknown };
  if (!isJobId(b.jobId)) return 'jobId must be a job id';
  if (!isCredentialsDirOf(b.dir, b.jobId)) return 'dir must be the job\'s own credentials dir';
  if (!isCredentialFile(b.file)) return 'file must be a relative path of plain names';
  if (typeof b.content !== 'string' || b.content.length > 64 * 1024) return 'content must be text of at most 64 KiB';
  return { argv: credentialArgv(b.jobId, b.dir, b.file, b.make === true), input: b.content };
}

