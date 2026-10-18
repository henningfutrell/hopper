// Issue #1875: the test image (scripts/box/test.Dockerfile) is the claude box image of the same commit with Python,
// Playwright's Chromium headless shell, its libraries and fonts, prebuilt and non-root; the image workflow publishes it
// under the tag TEST_IMAGE names, as the box images are published.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BOX_IMAGE, TEST_IMAGE } from '../../src/sandbox/box-image.ts';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

describe('the test image (issue #1875)', () => {
  const file = read('scripts/box/test.Dockerfile');
  const workflow = read('.github/workflows/image.yml');

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
