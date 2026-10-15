// Writes the Containerfile of a published tools image to stdout (issue #1286; .github/workflows/image.yml `box-tools`):
// the box image `base` with every box tool added, as the hopper adds them to a box's image (src/sandbox/tools.ts).
// `--read-only`: the image of a read-only template's boxes, terraform behind the read-only wrapper. A runtime that
// builds nothing (Kubernetes) runs these (src/sandbox/launch.ts `publishedToolsImage`).
//
//   node scripts/box-tools-containerfile.ts ghcr.io/henningfutrell/hopper:box-claude-sha-<commit> [--read-only]
import { BOX_TOOLS } from '../src/domain/sandboxes.ts';
import { toolsImage } from '../src/sandbox/tools.ts';

const [base, ...flags] = process.argv.slice(2);
if (!base || flags.some((f) => f !== '--read-only')) {
  console.error('usage: node scripts/box-tools-containerfile.ts <box image> [--read-only]');
  process.exit(2);
}
process.stdout.write(toolsImage({ image: base }, BOX_TOOLS, { readOnly: flags.includes('--read-only') }).containerfile);
