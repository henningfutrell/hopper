// The compose file a build ships with (issue #697, design.md "Self-update"): every image carries the compose.yaml of its
// own commit, so an update fetches the compose file of the image it updates to, never keeps an old one. Stamped with the
// version (branch and commit) on its first line: the next update names its backup after it.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ShippedCompose } from '../domain/types.ts';
import { readInstallInfo } from './install.ts';

export const SHIPPED_COMPOSE_FILE = 'compose.yaml';

/** The directory of this build: the checkout, the install or the image's /app. */
export const BUILD_DIR = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** The stamp's prefix, on the first line of the compose file an update puts in. */
export const VERSION_STAMP = '# hopper version:';

/** The compose file `appDir` ships with, and the branch and commit its install.json names; a reason when it ships none. */
export function readShippedCompose(appDir: string): { ok: true; shipped: ShippedCompose } | { ok: false; reason: string } {
  const path = join(appDir, SHIPPED_COMPOSE_FILE);
  if (!existsSync(path)) return { ok: false, reason: `this build ships no ${SHIPPED_COMPOSE_FILE} (${path}): an image built before it carried one` };
  const { known } = readInstallInfo(appDir);
  const body = readFileSync(path, 'utf8');
  const stamp = known.branch && known.commit ? `${VERSION_STAMP} ${known.branch} ${known.commit}` : `${VERSION_STAMP} unknown`;
  return {
    ok: true,
    shipped: {
      ...(known.branch ? { branch: known.branch } : {}),
      ...(known.commit ? { commit: known.commit } : {}),
      compose: `${stamp}\n${body}`,
    },
  };
}
