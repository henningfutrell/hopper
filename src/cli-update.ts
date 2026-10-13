// `hopper update` (issues #697, #970, design.md "Self-update"): what the update of a container install needs from the
// image to update to. Needs no database: it is run as `podman run --rm -i <image> hopper update carry …` on the host.
// `carry` answers the new compose.yaml: the one this image ships with, the settings of the old one (on stdin) as its
// variables' defaults. It reads no .env and writes no file; what the new file cannot hold, it says on stderr.
import { parseArgs } from 'node:util';
import type { CliIo } from './cli.ts';
import { carryCompose, carryOverride } from './update/compose-carry.ts';
import { BUILD_DIR, readShippedCompose } from './update/shipped-compose.ts';
import { COMPOSE_TOOLS, IMAGE_REF, PUBLISHED_IMAGE, updateCommands, updateLines, type ComposeTool } from './update/update-commands.ts';
import { UPDATE_SKILL } from './update/update-skill.ts';
import { DRIFT_USAGE } from './cli-update-drift.ts';

export const UPDATE_USAGE = `  hopper update carry --image <ref>                  print the compose.yaml of this image's version, with the settings of
                                                     the old compose.yaml (on stdin) as its defaults and <ref> as
                                                     HOPPER_IMAGE; run as <tool> run --rm -i <ref> hopper update carry
                                                     --image <ref> < compose.yaml > compose.yaml.next
  hopper update compose                              print the compose.yaml this build ships with, stamped with its version
  hopper update skill                                print the steps an agent follows to update a container hopper
${DRIFT_USAGE}`;

/**
 * Issue #1013: the update commands issue #970 removed. `hopper update <tool> > hopper-update.sh` was the documented update
 * before it; run now, it says so and gives the commands that replace it, on stderr, so the script file stays empty.
 */
function removed(what: string, image: string | undefined): string | undefined {
  const tool = COMPOSE_TOOLS.find((t) => t === what) as ComposeTool | undefined;
  if (what === 'override') {
    return `'hopper update override' was removed: hopper update carry says on stderr what goes in compose.override.yaml. The whole update: hopper update skill\n`;
  }
  if (!tool) return undefined;
  const ref = image && IMAGE_REF.test(image) ? image : `${PUBLISHED_IMAGE}:<channel>`;
  const lines = updateLines(updateCommands(tool, ref)).map((l) => `  ${l}\n`).join('');
  return `'hopper update ${tool}' was removed: it made an update script, and the update is now plain compose commands. `
    + `In the folder that holds compose.yaml, run these one at a time (the steps, with what each does: hopper update skill):\n${lines}`;
}

/** `hopper update …`; the exit code. */
export function runUpdate(args: string[], io: CliIo, appDir = BUILD_DIR): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { image: { type: 'string' } } });
  const [what, ...extra] = positionals;
  const fail = (text: string, code = 2): number => { io.err(`hopper update: ${text}\n`); return code; };
  if (extra.length > 0 || what === undefined) return fail(`usage:\n${UPDATE_USAGE}`);
  if (what === 'skill') { io.out(UPDATE_SKILL); return 0; }
  const gone = removed(what, values.image);
  if (gone !== undefined) return fail(gone);
  if (what !== 'compose' && what !== 'carry') return fail(`unknown command ${what}; usage:\n${UPDATE_USAGE}`);
  const read = readShippedCompose(appDir);
  if (!read.ok) return fail(read.reason, 1);
  if (what === 'compose') { io.out(read.shipped.compose); return 0; }
  if (!values.image || !IMAGE_REF.test(values.image)) return fail('carry needs --image <ref>, the image updated to');
  const old = io.stdin();
  if (!old.trim()) return fail('no compose.yaml on stdin: run it as … hopper update carry --image <ref> < compose.yaml', 1);
  const carried = carryCompose({ old, shipped: read.shipped.compose, image: values.image });
  for (const note of carried.notes) io.err(`hopper update: ${note}\n`);
  // What the new compose.yaml cannot hold is said, never dropped in silence: the person adds it to compose.override.yaml.
  const kept = carryOverride(old, carried.compose, undefined, carried.overrideEnv);
  if (kept.override !== undefined) {
    io.err(`hopper update: the new compose.yaml cannot hold all of the old one. Add this to compose.override.yaml (keep what it has), then start the stack:\n${kept.override}`);
  }
  io.out(carried.compose);
  return 0;
}
