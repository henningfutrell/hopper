// Issue #1286: a runtime that builds nothing (Kubernetes) runs the tools image CI published for the box image, in place
// of the one the hopper builds on a socket.
//
// Feature: published tools images
//   Scenario: a box with tools runs the box image's published tools image
//   Scenario: a read-only template's box runs the read-only one
//   Scenario: a box with no tools runs its image as it is
//   Scenario: an image the hopper does not publish cannot get tools there
//   Scenario: CI writes the Containerfile of each published tools image
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BOX_TOOLS } from '../../src/domain/sandboxes.ts';
import { boxImage, publishedToolsImage } from '../../src/sandbox/box-image.ts';
import { createKubernetesRuntime } from '../../src/sandbox/kubernetes.ts';
import { toolsImage } from '../../src/sandbox/tools.ts';
import { createFakeKubeApi } from '../support/fake-kube-api.ts';

const rt = () => createKubernetesRuntime({ api: createFakeKubeApi(), hopper: { namespace: 'hopper', labels: { app: 'hopper' }, port: 4790 } });
const BOX = 'ghcr.io/henningfutrell/hopper:box-claude';

describe('published tools images', () => {
  it('a box with tools runs the box image\'s published tools image', async () => {
    expect(await boxImage(rt(), BOX, ['kubectl'])).toEqual({ image: `${BOX}-tools`, user: '1000:1000' });
    expect(publishedToolsImage(`${BOX}-dev`)).toBe(`${BOX}-dev-tools`);
  });

  it('a read-only template\'s box runs the read-only one', async () => {
    expect(await boxImage(rt(), BOX, ['terraform', 'aws'], true)).toEqual({ image: `${BOX}-tools-read-only`, user: '1000:1000' });
  });

  it('a box with no tools runs its image as it is', async () => {
    expect(await boxImage(rt(), 'registry.example/own:1', [])).toEqual({ image: 'registry.example/own:1', user: '1000:1000' });
  });

  it('an image the hopper does not publish cannot get tools there', async () => {
    await expect(boxImage(rt(), 'registry.example/own:1', ['helm'])).rejects.toThrow(/builds no image/);
    expect(() => publishedToolsImage(`${BOX}@sha256:${'0'.repeat(64)}`)).toThrow(/builds no image/);
  });

  it('CI writes the Containerfile of each published tools image', () => {
    const out = (args: string[]): string => execFileSync(process.execPath, ['scripts/box-tools-containerfile.ts', ...args], { encoding: 'utf8' });
    expect(out([`${BOX}-sha-abc1234`])).toBe(toolsImage({ image: `${BOX}-sha-abc1234` }, BOX_TOOLS).containerfile);
    expect(out([`${BOX}-sha-abc1234`, '--read-only'])).toBe(toolsImage({ image: `${BOX}-sha-abc1234` }, BOX_TOOLS, { readOnly: true }).containerfile);
  });
});
