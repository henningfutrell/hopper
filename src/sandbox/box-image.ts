// The image a sandbox runs (issues #708, #716, #1286): a template's approved image, else the published box image of an
// agent, with the template's tools added — built once per base image and set of tools, or, on a runtime that builds
// nothing, the tools image CI publishes. A need box and a check box run it; neither runs as root.
import type { BoxTool, ContainerRuntime } from '../domain/sandboxes.ts';
import { isRootUser } from './flags.ts';
import { toolsImage } from './tools.ts';

/** The published image a box of an agent runs: its `box-<agent>` tag. */
export const BOX_IMAGE = 'ghcr.io/henningfutrell/hopper';

/**
 * The tools image CI publishes for a box image (issue #1286, .github/workflows/image.yml `box-tools`): the box image with
 * every box tool added as tools.ts adds them, its tag the box image's with `-tools`, or `-tools-read-only` for a
 * read-only template's boxes. A runtime that builds nothing (Kubernetes) runs it. Throws for an image the hopper does
 * not publish.
 */
export function publishedToolsImage(base: string, readOnly?: boolean): string {
  if (!base.startsWith(`${BOX_IMAGE}:box-`) || base.includes('@')) {
    throw new Error(`the image ${base} has no published tools image, and this container runtime builds no image: a box with tools runs a hopper box image (${BOX_IMAGE}:box-<agent>) here`);
  }
  return `${base}${readOnly ? '-tools-read-only' : '-tools'}`;
}

/**
 * The image a box runs, and its user: `base`, with `tools` added when it names any (issue #716), built once per base and
 * set of tools — or, on a runtime that builds nothing, the published tools image, which has every tool (issue #1286).
 * `readOnly`: a read-only template's box, whose terraform runs through the read-only wrapper (issue #715).
 */
export async function boxImage(runtime: ContainerRuntime, base: string, tools: readonly BoxTool[] | undefined, readOnly?: boolean): Promise<{ image: string; user: string }> {
  const read = await runtime.pull(base);
  if (isRootUser(read.user)) throw new Error(`the image ${base} runs as root: a sandbox box runs as a non-root user (USER in its image)`);
  if (!tools?.length) return { image: base, user: read.user };
  if (!runtime.build) {
    const image = publishedToolsImage(base, readOnly);
    return { image, user: (await runtime.pull(image)).user };
  }
  const built = toolsImage({ image: base, id: read.id }, tools, { readOnly });
  // A build that fails is the hopper's failure, not the command's (issue #1737): the message says so to the job.
  await runtime.build(built.tag, built.containerfile).catch((e: unknown) => {
    throw new Error(`the hopper could not build the box's tools image, so the command did not run (a failure of the hopper, not of the command; run the step again): ${e instanceof Error ? e.message : String(e)}`);
  });
  return { image: built.tag, user: (await runtime.pull(built.tag)).user };
}
