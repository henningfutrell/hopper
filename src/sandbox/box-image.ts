// The image a sandbox runs (issues #708, #716, #1286): a template's approved image, else the published box image of an
// agent, with the template's tools added — built once per base image and set of tools, or, on a runtime that builds
// nothing, the tools image CI publishes. A need box and a check box run it; neither runs as root.
import { fileURLToPath } from 'node:url';
import type { BoxTool, ContainerRuntime } from '../domain/sandboxes.ts';
import { readInstallInfo } from '../update/install.ts';
import { isRootUser } from './flags.ts';
import { toolsImage } from './tools.ts';

/** The published image a box of an agent runs: its `box-<agent>` tag. */
export const BOX_IMAGE = 'ghcr.io/henningfutrell/hopper';

/**
 * The agents with a published box image (issue #865): each harness a print-mode or herdr executor drives, so the hopper
 * stays harness-agnostic. scripts/box/Dockerfile installs each one, and .github/workflows/image.yml publishes each one.
 */
export const BOX_AGENTS = ['claude', 'codex', 'cursor', 'omp', 'opencode'] as const;

/**
 * The test image (issue #1875, scripts/box/test.Dockerfile): the claude box image with Python and Playwright's Chromium
 * headless shell, its system libraries and fonts, so a box step runs an end-to-end test with no package downloads. CI
 * publishes it beside the box images (.github/workflows/image.yml `box-test`). A template request names it `--image test`.
 */
export const TEST_IMAGE = `${BOX_IMAGE}:box-test`;

/** The branches CI publishes a `box-test-<branch>` tag of; `box-test` itself follows stable. */
const TEST_IMAGE_BRANCHES: readonly string[] = ['dev', 'beta', 'canary'];

/**
 * The test image a box pulls (issue #1976): the tag of the branch the hopper was built from, so a hopper of dev, beta or
 * canary runs the test image of its own channel, as published before stable has one; else `box-test`.
 */
export const testImageOf = (branch: string | undefined): string =>
  (branch !== undefined && TEST_IMAGE_BRANCHES.includes(branch) ? `${TEST_IMAGE}-${branch}` : TEST_IMAGE);

let built: { branch: string | undefined } | undefined;
/** The branch this build was made from, as its install.json says; read once. Undefined for a checkout with none. */
const buildBranch = (): string | undefined => (built ??= { branch: readInstallInfo(fileURLToPath(new URL('../..', import.meta.url))).known.branch }).branch;

/** The image a box of a template that names `named` pulls (issue #1976): the test image of `branch`, else `named`. */
export const pulledImage = (named: string, branch = buildBranch()): string => (named === TEST_IMAGE ? testImageOf(branch) : named);

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
 * The image a box runs, and its user: `named`, with `tools` added when it names any (issue #716), built once per base and
 * set of tools — or, on a runtime that builds nothing, the published tools image, which has every tool (issue #1286).
 * `readOnly`: a read-only template's box, whose terraform runs through the read-only wrapper (issue #715). A template
 * keeps the test image as `TEST_IMAGE`; the box pulls the one of `branch`, the hopper's own by default (issue #1976).
 */
export async function boxImage(runtime: ContainerRuntime, named: string, tools: readonly BoxTool[] | undefined, readOnly?: boolean, branch = buildBranch()): Promise<{ image: string; user: string }> {
  const base = pulledImage(named, branch);
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
