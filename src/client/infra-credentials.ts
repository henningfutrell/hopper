// Infra credentials on a machine (issue #1128 part 7, design.md "Infra credentials on machines"): a machine the hopper runs jobs
// on must hold no infra credentials, so each probe reads which infra credential folders are in its home — this machine and a
// client target (its `/release` answer) with a read of the home here, an ssh target with what INFRA_CREDENTIALS_COMMAND prints in
// its probe. Only the folder names: nothing in them is read. Shared with the hopper's machine sources (src/machines/).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** The infra credential folders a machine's home must not hold. */
export const INFRA_CREDENTIAL_FOLDERS = ['.aws', '.keycloak', '.terraform.d'] as const;

const MARK = 'hopper-cred ';
const READ = 'hopper-cred-read';

/** The ones `home` holds, folder or file, in the list's order. */
export function infraCredentialsAt(home: string): string[] {
  return INFRA_CREDENTIAL_FOLDERS.filter((n) => existsSync(join(home, n)));
}

/** What an ssh target's probe runs: a line that it read, then one per folder its home holds. */
export const INFRA_CREDENTIALS_COMMAND = `echo ${READ}; for d in ${INFRA_CREDENTIAL_FOLDERS.join(' ')}; do [ -e "$HOME/$d" ] && echo "${MARK}$d"; done; true`;

/** The folders in what INFRA_CREDENTIALS_COMMAND printed; undefined when it did not run. */
export function readInfraCredentials(stdout: string): string[] | undefined {
  const lines = stdout.split('\n').map((l) => l.trim());
  if (!lines.includes(READ)) return undefined;
  return INFRA_CREDENTIAL_FOLDERS.filter((n) => lines.includes(`${MARK}${n}`));
}

/** A client's answer, believed only for names on the list; undefined when it is no list (a client older than this). */
export function infraCredentialsOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return INFRA_CREDENTIAL_FOLDERS.filter((n) => v.includes(n));
}

/** A line of a probe's output that INFRA_CREDENTIALS_COMMAND printed. */
export const isInfraCredentialsLine = (l: string): boolean => l === READ || l.startsWith(MARK);
