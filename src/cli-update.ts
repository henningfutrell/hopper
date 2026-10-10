// `hopper update` (issue #697, design.md "Self-update"): the one update of a container install, from the image to update
// to. Needs no database: it is run as `podman run --rm <image> hopper update <tool>` on the host, and prints what the
// host runs. `carry` is the script's own step: the .env lines that keep an old compose.yaml's own settings.
import { parseArgs } from 'node:util';
import type { CliIo } from './cli.ts';
import { carryLocalSettings } from './update/compose-carry.ts';
import { readInstallInfo } from './update/install.ts';
import { BUILD_DIR, readShippedCompose } from './update/shipped-compose.ts';
import { COMPOSE_TOOLS, IMAGE_REF, isComposeTool, PUBLISHED_IMAGE, updateScript } from './update/update-script.ts';
import { UPDATE_SKILL } from './update/update-skill.ts';

export const UPDATE_USAGE = `  hopper update <${COMPOSE_TOOLS.join('|')}> [--image <ref>]
                                                     print the script that updates a container install to this image's
                                                     version: run it as <tool> run --rm <image> hopper update <tool>,
                                                     in the folder of compose.yaml (--image: default the channel's image)
  hopper update compose                              print the compose.yaml this build ships with, stamped with its version
  hopper update skill                                print the steps an agent follows to update a container hopper`;

/** `hopper update …`; the exit code. */
export function runUpdate(args: string[], io: CliIo, appDir = BUILD_DIR): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { image: { type: 'string' } } });
  const [what, ...extra] = positionals;
  const fail = (text: string, code = 2): number => { io.err(`hopper update: ${text}\n`); return code; };
  if (extra.length > 0 || what === undefined) return fail(`usage:\n${UPDATE_USAGE}`);
  if (what === 'skill') { io.out(UPDATE_SKILL); return 0; }
  const read = readShippedCompose(appDir);
  if (!read.ok) return fail(read.reason, 1);
  if (what === 'compose') { io.out(read.shipped.compose); return 0; }
  if (what === 'carry') {
    const carried = carryLocalSettings(io.stdin(), read.shipped.compose);
    for (const note of carried.notes) io.err(`hopper update: note: ${note}\n`);
    io.out(carried.env.map((l) => `${l}\n`).join(''));
    return 0;
  }
  if (!isComposeTool(what)) return fail(`unknown tool ${what}; one of ${COMPOSE_TOOLS.join(', ')}`);
  const branch = readInstallInfo(appDir).known.branch;
  const image = values.image ?? (branch ? `${PUBLISHED_IMAGE}:${branch}` : undefined);
  if (!image) return fail('this build does not know its channel: name the image with --image <ref>');
  if (!IMAGE_REF.test(image)) return fail(`not an image reference: ${image}`);
  io.out(updateScript({ tool: what, image, shipped: read.shipped }));
  return 0;
}
