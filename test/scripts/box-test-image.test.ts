// Issue #1875: the test image (scripts/box/test.Dockerfile) is the claude box image of the same commit with Python,
// Playwright's Chromium headless shell, its libraries and fonts, prebuilt and non-root; the image workflow publishes it
// under the tag TEST_IMAGE names, as the box images are published.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOX_IMAGE, boxImage, pulledImage, TEST_IMAGE, testImageOf } from '../../src/sandbox/box-image.ts';
import { createFakeContainerRuntime } from '../support/fake-container-runtime.ts';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

const workflow = read('.github/workflows/image.yml');

describe('the test image (issue #1875)', () => {
  const file = read('scripts/box/test.Dockerfile');

  it('installs Python, Playwright with the headless shell and its libraries, and fonts, outside the home', () => {
    expect(file).toMatch(/python3 python3-venv/);
    expect(file).toMatch(/fonts-liberation/);
    expect(file).toMatch(/pip install --no-cache-dir playwright/);
    expect(file).toMatch(/playwright install --with-deps --only-shell chromium/);
    expect(file).toMatch(/PLAYWRIGHT_BROWSERS_PATH=\/opt\/playwright/);
  });

  it('builds on the box image and ends as its non-root user', () => {
    expect(file).toMatch(/^FROM \$\{BASE\}$/m);
    const users = [...file.matchAll(/^USER (\S+)$/gm)].map((m) => m[1]);
    expect(users.at(-1)).toBe('agent');
  });

  it('the image workflow publishes it on the box image of this commit, under the tag TEST_IMAGE names', () => {
    expect(TEST_IMAGE).toBe(`${BOX_IMAGE}:box-test`);
    const job = workflow.slice(workflow.indexOf('\n  box-test:'));
    expect(job).toMatch(/needs: box\n/);
    expect(job).toMatch(/file: scripts\/box\/test\.Dockerfile/);
    expect(job).toMatch(/type=raw,value=box-test,enable=\$\{\{ github\.ref_name == 'stable' \}\}/);
    expect(job).toMatch(/box-claude-sha-\$\{GITHUB_SHA::7\}/);
  });
});

// Issue #1976: `box-test` follows stable, so a hopper of another channel offered `--image test` before stable published
// it, and a box's pull failed with "manifest unknown". A box pulls the test image of the branch the hopper was built from.
describe('the test image of the hopper\'s own branch (issue #1976)', () => {
  it('a build of dev, beta or canary pulls that branch\'s tag; stable, a checkout or another branch pulls box-test', () => {
    expect(testImageOf('dev')).toBe(`${BOX_IMAGE}:box-test-dev`);
    expect(testImageOf('beta')).toBe(`${BOX_IMAGE}:box-test-beta`);
    expect(testImageOf('canary')).toBe(`${BOX_IMAGE}:box-test-canary`);
    for (const branch of ['stable', 'main', undefined]) expect(testImageOf(branch)).toBe(TEST_IMAGE);
  });

  it('the image a template\'s box pulls is the one a template request checks is published (issue #1977)', () => {
    expect(pulledImage(TEST_IMAGE, 'dev')).toBe(`${BOX_IMAGE}:box-test-dev`);
    expect(pulledImage(`${BOX_IMAGE}:box-claude`, 'dev')).toBe(`${BOX_IMAGE}:box-claude`);
  });

  it('the image workflow publishes the tag of each branch it runs on', () => {
    const job = workflow.slice(workflow.indexOf('\n  box-test:'));
    expect(job).toMatch(/type=ref,event=branch,prefix=box-test-\n/);
    expect(workflow).toMatch(/branches: \[dev, beta, canary, stable\]/);
  });

  it('a box of a template that names the test image runs the test image of the hopper\'s branch, with its tools built on it', async () => {
    const runtime = createFakeContainerRuntime();
    expect(await boxImage(runtime, TEST_IMAGE, undefined, false, 'dev')).toEqual({ image: `${BOX_IMAGE}:box-test-dev`, user: 'agent' });
    const { image } = await boxImage(runtime, TEST_IMAGE, ['kubectl'], false, 'dev');
    expect(runtime.images.get(image)).toMatch(new RegExp(`^FROM ${BOX_IMAGE}:box-test-dev$`, 'm'));
    expect(await boxImage(runtime, `${BOX_IMAGE}:box-claude`, undefined, false, 'dev')).toEqual({ image: `${BOX_IMAGE}:box-claude`, user: 'agent' });
  });
});
