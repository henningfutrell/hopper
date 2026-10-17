// Leftover box builds (issue #1120, part 4; design.md "Hopper's own disk use"): the images the hopper built for box tools
// (tools.ts) stayed on the machine after their boxes went, and so did the images each build kept of its fetch stage. A
// leftover box build is one of those that no container uses, that no sandbox record names, and that was built more
// than LEFTOVER_BUILD_MS ago. The sandbox module removes them from the runtime beside the hopper, at most once in
// LEFTOVER_PASS_MS, and from each client target's through its client (issue #1202), never forced: the runtime keeps one a container uses, or one that is the parent of another (it goes
// with its child). An image of anyone else's is never taken: only a tag of the hopper's own repository, or no tag and
// the hopper's stage label, makes one the hopper's.
import type { ContainerRuntime, ListedImage } from '../domain/sandboxes.ts';
import { TOOLS_IMAGE, TOOLS_STAGE_LABEL } from './tools.ts';

/** How long a box build is kept after it was built, used or not: a box of the same tools soon after takes it, unbuilt. */
export const LEFTOVER_BUILD_MS = 7 * 24 * 60 * 60_000;
/** How often the sandbox module looks for leftover box builds. */
export const LEFTOVER_PASS_MS = 60 * 60_000;

const bare = (id: string): string => id.replace(/^sha256:/, '');

/** The image is one the hopper built for box tools, or a stage such a build kept. */
const ours = (i: ListedImage): boolean =>
  i.tags.length > 0 ? i.tags.every((t) => t.startsWith(`${TOOLS_IMAGE}:`)) : i.labels[TOOLS_STAGE_LABEL] !== undefined;

/** The leftover box builds among `images`, newest first (a child before its parent). `inUse`: image names and ids. Pure. */
export function leftoverBuilds(images: readonly ListedImage[], o: { inUse: ReadonlySet<string>; now: Date; keepMs?: number }): ListedImage[] {
  const used = new Set([...o.inUse].map(bare));
  const before = o.now.getTime() - (o.keepMs ?? LEFTOVER_BUILD_MS);
  return images
    .filter((i) => ours(i) && i.createdAt <= before && !used.has(bare(i.id)) && !i.tags.some((t) => used.has(t)))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Removes the leftover box builds from `runtime`; answers how many it removed. `inUse`: the images the sandbox records
 * name, beside the ones the runtime's containers use. `where`: the runtime's place, for the log line. A runtime that lists
 * no images removes none.
 */
export async function removeLeftoverBuilds(c: { runtime: ContainerRuntime; now: Date; inUse: Iterable<string>; where?: string; logger: { info(line: string): void } }): Promise<number> {
  const rt = c.runtime;
  if (!rt.listImages || !rt.removeImage) return 0;
  const inUse = new Set([...c.inUse, ...(await rt.list()).map((x) => x.image)]);
  let removed = 0;
  for (const i of leftoverBuilds(await rt.listImages(), { inUse, now: c.now })) if (await rt.removeImage(i.id)) removed++;
  const days = Math.round(LEFTOVER_BUILD_MS / (24 * 60 * 60_000));
  if (removed) c.logger.info(`hopper: removed ${removed} leftover box ${removed === 1 ? 'build' : 'builds'} ${c.where ?? 'beside the hopper'} (images it built for box tools more than ${days} days ago that no box uses)`);
  return removed;
}
