// Issue #865: the hopper supports any harness, so the sandbox box image (scripts/box/Dockerfile) installs each agent
// CLI the playground and the lane pods offer (BOX_AGENTS), and the image workflow publishes a box image of each.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOX_AGENTS } from '../../src/sandbox/box-image.ts';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('the box image of each harness', () => {
  it('the Dockerfile installs every agent in BOX_AGENTS, and no other', () => {
    const cases = [...read('scripts/box/Dockerfile').matchAll(/^\s+(\w+)\) /gm)].map((m) => m[1]);
    expect(cases.sort()).toEqual([...BOX_AGENTS].sort());
  });

  it('the image workflow publishes a box image and its tools images of every agent', () => {
    const matrices = [...read('.github/workflows/image.yml').matchAll(/^\s+agent: \[(.*)\]$/gm)].map((m) => m[1]!.split(',').map((a) => a.trim()));
    expect(matrices).toHaveLength(2);
    for (const agents of matrices) expect(agents).toEqual([...BOX_AGENTS]);
  });
});
