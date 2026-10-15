// `hopper update` (issues #697, #970, #1104, design.md "Self-update"): what the update of a container install needs from
// the image to update to. Needs no database: it is run as `podman run --rm <image> hopper update …` on the host. `script`
// answers scripts/update.sh, the update itself, piped to bash on the host. `carry` answers the new compose.yaml: the one
// this image ships with, the settings of the old one (on stdin) as its variables' defaults. It reads no .env and writes no
// file; what the new file cannot hold, it says on stderr. In a cluster install (issue #1285) there is no compose step:
// `skill` prints the Helm update, and `script`, `carry` and `compose` refuse and say so.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import type { CliIo } from './cli.ts';
import { clusterInstall, helmUpgradeCommand } from './update/cluster.ts';
import { carryCompose, carryOverride, PODMAN_SOCKET_PATH } from './update/compose-carry.ts';
import { COMPOSE, composeConflicts, conflictLine, dropRedundant, OVERRIDE, OVERRIDE_MARK } from './update/compose-conflicts.ts';
import { BUILD_DIR, readShippedCompose } from './update/shipped-compose.ts';
import { COMPOSE_TOOLS, IMAGE_REF, PUBLISHED_IMAGE, runtimeOf, updateCommand, type ComposeTool } from './update/update-commands.ts';
import { updateSkill } from './update/update-skill.ts';
import { DRIFT_USAGE } from './cli-update-drift.ts';

export const UPDATE_USAGE = `  hopper update script                               print the update of a container install (scripts/update.sh); run in the
                                                     folder that holds compose.yaml: <tool> run --rm --pull=always <ref>
                                                     hopper update script | bash -s -- <ref>
  hopper update carry --image <ref>                  print the compose.yaml of this image's version, with the settings of
                                                     the old compose.yaml (on stdin) as its defaults and <ref> as
                                                     HOPPER_IMAGE; run as <tool> run --rm -i <ref> hopper update carry
                                                     --image <ref> < compose.yaml > compose.yaml.next. --podman-socket
                                                     <path>: the rootless Podman socket on the host, mounted into the
                                                     hopper; empty or absent: none (/dev/null). --with-override: stdin
                                                     is compose.yaml, a line '${OVERRIDE_MARK}', then
                                                     compose.override.yaml; it refuses (exit 4) while the two conflict
  hopper update check --image <ref> --with-override  carry's check alone: the conflicts of the new compose.yaml and
                                                     compose.override.yaml, as JSON; exit 4 when one stops the update
  hopper update fix-override --image <ref> --with-override
                                                     print compose.override.yaml without the entries compose.yaml gives
                                                     itself; exit 4, and nothing printed, when another conflict stays
  hopper update compose                              print the compose.yaml this build ships with, stamped with its version
  hopper update skill                                print the steps an agent follows to update a container hopper; in a
                                                     Kubernetes pod, those of a cluster install (helm upgrade)
${DRIFT_USAGE}`;

/**
 * Issue #1013: the update commands issue #970 removed. `hopper update <tool> > hopper-update.sh` was the documented update
 * before it; run now, it says so and gives the command that replaces it (issue #1104), on stderr, so the script file stays empty.
 */
function removed(what: string, image: string | undefined): string | undefined {
  const tool = COMPOSE_TOOLS.find((t) => t === what) as ComposeTool | undefined;
  if (what === 'override') {
    return `'hopper update override' was removed: hopper update carry says on stderr what goes in compose.override.yaml. The whole update: hopper update skill\n`;
  }
  if (!tool) return undefined;
  const ref = image && IMAGE_REF.test(image) ? image : `${PUBLISHED_IMAGE}:<channel>`;
  return `'hopper update ${tool}' was removed: it made an update script to keep. The update is now one command. `
    + `In the folder that holds compose.yaml, run (what it does: hopper update skill):\n  ${updateCommand(runtimeOf(tool), ref)}\n`;
}

/** A conflict of compose.yaml and compose.override.yaml stops the update (issue #1246): not 1 (a failure), 2 (a refusal) or 3 (drift). */
export const CONFLICT_EXIT = 4;

/** `hopper update …`; the exit code. */
export function runUpdate(args: string[], io: CliIo, appDir = BUILD_DIR): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { image: { type: 'string' }, 'podman-socket': { type: 'string' }, 'with-override': { type: 'boolean' } } });
  const [what, ...extra] = positionals;
  const fail = (text: string, code = 2): number => { io.err(`hopper update: ${text}\n`); return code; };
  if (extra.length > 0 || what === undefined) return fail(`usage:\n${UPDATE_USAGE}`);
  const cluster = clusterInstall(io.env);
  if (what === 'skill') { io.out(updateSkill(cluster)); return 0; }
  if (cluster && (what === 'script' || what === 'carry' || what === 'compose')) {
    const helm = helmUpgradeCommand(cluster, 'sha-<commit>');
    return fail(`'hopper update ${what}' is for a compose install. This is a cluster install: update it with helm upgrade of its release:\n  ${helm}\nThe steps: hopper update skill`);
  }
  if (what === 'script') {
    try { io.out(readFileSync(join(appDir, 'scripts', 'update.sh'), 'utf8')); } catch { return fail(`this build ships no scripts/update.sh (${appDir})`, 1); }
    return 0;
  }
  const gone = removed(what, values.image);
  if (gone !== undefined) return fail(gone);
  if (!['compose', 'carry', 'check', 'fix-override'].includes(what)) return fail(`unknown command ${what}; usage:\n${UPDATE_USAGE}`);
  const read = readShippedCompose(appDir);
  if (!read.ok) return fail(read.reason, 1);
  if (what === 'compose') { io.out(read.shipped.compose); return 0; }
  if (!values.image || !IMAGE_REF.test(values.image)) return fail('carry needs --image <ref>, the image updated to');
  const input = io.stdin();
  const mark = values['with-override'] ? input.indexOf(`\n${OVERRIDE_MARK}\n`) : -1;
  if (values['with-override'] && mark < 0) return fail(`--with-override: no line '${OVERRIDE_MARK}' on stdin after compose.yaml`);
  const old = mark < 0 ? input : input.slice(0, mark + 1);
  const override = mark < 0 ? undefined : input.slice(mark + OVERRIDE_MARK.length + 2);
  if (!old.trim()) return fail('no compose.yaml on stdin: run it as … hopper update carry --image <ref> < compose.yaml', 1);
  const podmanSocket = values['podman-socket'] || undefined;
  if (podmanSocket !== undefined && !PODMAN_SOCKET_PATH.test(podmanSocket)) return fail(`--podman-socket ${podmanSocket}: not an absolute path compose.yaml can hold`);
  const carried = carryCompose({ old, shipped: read.shipped.compose, image: values.image, ...(podmanSocket ? { podmanSocket } : {}) });
  // The merge compose starts, checked before the stack goes down (issue #1246).
  const check = composeConflicts([{ name: COMPOSE, text: carried.compose }, ...(override === undefined ? [] : [{ name: OVERRIDE, text: override }])]);
  if (check.unread) return fail(`${check.unread}: fix it, then run the update again. Nothing changed`, 1);
  const refused = check.conflicts.filter((c) => c.refuse);
  if (what === 'fix-override') {
    if (refused.some((c) => !c.fixable)) { for (const c of refused) io.err(`hopper update: ${conflictLine(c)}\n`); return CONFLICT_EXIT; }
    io.out(override === undefined ? '' : dropRedundant(override, check.conflicts));
    return 0;
  }
  for (const c of check.conflicts) io.err(`hopper update: ${conflictLine(c)}\n`);
  if (what === 'check') {
    io.out(`${JSON.stringify({ ok: refused.length === 0, conflicts: check.conflicts }, null, 2)}\n`);
    return refused.length ? CONFLICT_EXIT : 0;
  }
  if (refused.length) return fail(`compose.yaml and ${OVERRIDE} conflict: no compose.yaml printed. Nothing changed`, CONFLICT_EXIT);
  for (const note of carried.notes) io.err(`hopper update: ${note}\n`);
  // What the new compose.yaml cannot hold is said, never dropped in silence: the person adds it to compose.override.yaml.
  const kept = carryOverride(old, carried.compose, override, carried.overrideEnv);
  if (kept.override !== undefined) {
    io.err(`hopper update: the new compose.yaml cannot hold all of the old one. Add this to compose.override.yaml (keep what it has), then start the stack:\n${kept.override}`);
  }
  io.out(carried.compose);
  return 0;
}
