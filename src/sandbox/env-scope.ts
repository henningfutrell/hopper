// A job's environment scope (issue #2849, part 5; design.md "A job's environment scope"): when its user's setting scopes
// jobs, the job's agent keeps only some variables of its machine's environment — the names the setting keeps
// (src/domain/job-egress.ts `jobEnvKeep`), the names the hopper set for the job (`HOPPER_ENV_KEEP`, the pane's) and the
// names that start with `LC_` or `HERDR_` —; every other variable, a secret the machine's daemon or client was given
// among them, is absent, not hidden. The hopper writes this file into the job's credentials dir at each start, beside
// `hopper-egress`; the job's sandbox runner (src/client/job-sandbox.ts) reads it first, and with the scope on it runs
// itself again under `env -i` with the variables kept. Off, the file holds a comment only.

/** Set in a job's environment when its user's setting scopes it: the pane then names what the hopper set (`HOPPER_ENV_KEEP`). */
export const ENV_SCOPE_VARIABLE = 'HOPPER_ENV_SCOPE';
/** The names the hopper set for the job, space-separated: the pane's environment, which the scope keeps too. */
export const ENV_KEEP_VARIABLE = 'HOPPER_ENV_KEEP';
/** The file under the job's credentials dir. The sandbox runner names it as it is. */
export const ENV_SCOPE_FILE = 'hopper/env-scope';

/** A job's variables for its user's setting: none unless it scopes the job. */
export const envScopeVars = (s: { scope: boolean }): Record<string, string> => (s.scope ? { [ENV_SCOPE_VARIABLE]: '1' } : {});

/**
 * The names the hopper set in the pane's environment `env`, as `HOPPER_ENV_KEEP` (with the rest of `env`) when the job's
 * setting scopes it, else `env` as it is.
 */
export const withEnvKeep = (env: Readonly<Record<string, string>>): Record<string, string> =>
  (env[ENV_SCOPE_VARIABLE] ? { ...env, [ENV_KEEP_VARIABLE]: Object.keys(env).filter((k) => /^[A-Z][A-Z0-9_]*$/.test(k)).join(' ') } : { ...env });

/**
 * The file's text: with `keep` (the setting's names, src/domain/job-egress.ts `jobEnvKeep`), sh that the runner sources at
 * its start, which runs the runner again with only the variables kept, its arguments as they were; with none, a comment.
 * Its names are checked upper-case names, so each is safe in a shell word. Variables are read from `env`, so only exported
 * ones are kept, never a variable of the runner's own.
 */
export function envScopeScript(keep: readonly string[] | undefined): string {
  if (!keep) return '# hopper: this job\'s environment is not scoped (issue #2849 part 5). Written by the hopper at each job start.\n';
  const names = keep.filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n)).join(' ');
  return `# hopper: this job's environment scope (issue #2849 part 5). Written by the hopper at each job start; the job's sandbox
# runner sources it, and runs itself again with only these variables, what the hopper set for the job (HOPPER_ENV_KEEP),
# and the names that start with LC_ or HERDR_. Every other variable is absent.
k=' ${names} '" \${${ENV_KEEP_VARIABLE}:-} "
n=$#
set -- "$@" env -i HOPPER_ENV_SCOPED=1
for v in $(env | sed -n 's/^\\([A-Z][A-Z0-9_]*\\)=.*/\\1/p' | sort -u); do
  case $v in HOPPER_ENV_SCOPED) continue;; LC_*|HERDR_*) ;; *) case $k in *" $v "*) ;; *) continue;; esac;; esac
  eval "set -- \\"\\$@\\" \\"$v=\\\${$v}\\""
done
set -- "$@" "$0"
i=0; while [ "$i" -lt "$n" ]; do a=$1; shift; set -- "$@" "$a"; i=$((i+1)); done
exec "$@"
`;
}
