// Infra credentials on a machine (issue #1128 part 7, issue #1248, design.md "Infra credentials on machines"): a machine the
// hopper runs jobs on must give its jobs no credentials, so each probe reads which well-known credential places its job user's
// context holds — cloud CLI config, kube config, git credentials and credential helpers, ssh keys, token variables. This machine
// and a client target (its `/release` answer) with a read of the home and the environment here, an ssh target with what
// INFRA_CREDENTIALS_COMMAND prints in its probe. Only the names: no value is read, printed or sent. A machine that holds any is
// not ready and takes no new job (src/decider/assign.ts `credentialHolds`). Shared with the hopper's machine sources (src/machines/).
// A `.terraform.d` that holds only terraform's checkpoint files (its version check's cache) is no credential (issue #1502).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The places under the job user's home, folder or file, that hold credentials. */
export const INFRA_CREDENTIAL_PATHS = [
  '.aws', '.azure', '.config/gcloud', '.kube', '.keycloak', '.terraform.d',
  '.config/gh/hosts.yml', '.git-credentials', '.config/git/credentials', '.netrc',
  '.ssh/id_rsa', '.ssh/id_ecdsa', '.ssh/id_ecdsa_sk', '.ssh/id_ed25519', '.ssh/id_ed25519_sk', '.ssh/id_dsa',
] as const;

/** What terraform's version check writes into `.terraform.d` (issue #1502): a cache, no credential. */
const TERRAFORM_CHECKPOINT = ['checkpoint_cache', 'checkpoint_signature'];

/** Whether `path` under the home holds a credential: there, and for `.terraform.d` more than its checkpoint files. */
const holds = (home: string, path: string): boolean => {
  const at = join(home, path);
  if (!existsSync(at)) return false;
  if (path !== '.terraform.d') return true;
  try { return !statSync(at).isDirectory() || readdirSync(at).some((n) => !TERRAFORM_CHECKPOINT.includes(n)); } catch { return true; }
};

/** A credential helper in the job user's global git config: git would hand a job the host's credentials. */
export const GIT_CREDENTIAL_HELPER = 'git credential helper';

/** The variables that carry a token or point at credentials, when set and not empty. */
export const INFRA_CREDENTIAL_VARIABLES = [
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AZURE_CLIENT_SECRET', 'ARM_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS', 'KUBECONFIG', 'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'VAULT_TOKEN',
] as const;

/** Every name a read may say, in the order it says them: the paths, the git helper, then each variable as `$NAME`. */
export const INFRA_CREDENTIALS: readonly string[] = [...INFRA_CREDENTIAL_PATHS, GIT_CREDENTIAL_HELPER, ...INFRA_CREDENTIAL_VARIABLES.map((v) => `$${v}`)];

const MARK = 'hopper-cred ';
const READ = 'hopper-cred-read';

/** A `helper =` line in a git config: a credential helper (git's only `helper` key). */
const HELPER = /^\s*helper\s*=/im;

const hasHelper = (file: string): boolean => {
  try { return HELPER.test(readFileSync(file, 'utf8')); } catch { return false; }
};

/** The ones `home` and `env` hold, in the list's order. Names only. */
export function infraCredentialsAt(home: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  const helper = hasHelper(join(home, '.gitconfig')) || hasHelper(join(xdg, 'git/config'));
  return [
    ...INFRA_CREDENTIAL_PATHS.filter((n) => holds(home, n)),
    ...(helper ? [GIT_CREDENTIAL_HELPER] : []),
    ...INFRA_CREDENTIAL_VARIABLES.filter((v) => env[v]).map((v) => `$${v}`),
  ];
}

/** What an ssh target's probe runs: a line that it read, then one per credential there. printenv's value goes to /dev/null. */
export const INFRA_CREDENTIALS_COMMAND = `echo ${READ}; for d in ${INFRA_CREDENTIAL_PATHS.filter((d) => d !== '.terraform.d').join(' ')}; do [ -e "$HOME/$d" ] && echo "${MARK}$d"; done;`
  + ` t="$HOME/.terraform.d"; { [ -e "$t" ] && ! [ -d "$t" ] || [ -n "$(ls -A "$t" 2>/dev/null | grep -vx${TERRAFORM_CHECKPOINT.map((n) => ` -e ${n}`).join('')})" ]; } && echo '${MARK}.terraform.d';`
  + ` git config --global --get-regexp '^credential\\..*helper$' >/dev/null 2>&1 && echo '${MARK}${GIT_CREDENTIAL_HELPER}';`
  + ` for v in ${INFRA_CREDENTIAL_VARIABLES.join(' ')}; do [ -n "$(printenv "$v" 2>/dev/null)" ] && echo "${MARK}\\$$v"; done; true`;

/** The names in what INFRA_CREDENTIALS_COMMAND printed; undefined when it did not run. */
export function readInfraCredentials(stdout: string): string[] | undefined {
  const lines = stdout.split('\n').map((l) => l.trim());
  if (!lines.includes(READ)) return undefined;
  return INFRA_CREDENTIALS.filter((n) => lines.includes(`${MARK}${n}`));
}

/** A client's answer, believed only for names on the list; undefined when it is no list (a client older than this). */
export function infraCredentialsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return INFRA_CREDENTIALS.filter((n) => v.includes(n));
}

/** A line of a probe's output that INFRA_CREDENTIALS_COMMAND printed. */
export const isInfraCredentialsLine = (l: string): boolean => l === READ || l.startsWith(MARK);
