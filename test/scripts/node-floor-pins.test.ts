// Issue #2479: the images and `engines` stay on Node with the October 21, 2026 security release. Each Dockerfile's
// Node base names a patched version, the build checks the image's own Node against the floor, Dependabot bumps the
// bases, and `engines` names the same floors as src/client/node-floor.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NODE_FLOORS, nodeFloorOf } from '../../src/client/node-floor.ts';

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');
const DOCKERFILES = ['Dockerfile', 'scripts/box/Dockerfile'];

describe('the patched Node floor in the images and engines', () => {
  it('every Node base image names a whole version at or above the floor', () => {
    for (const file of DOCKERFILES) {
      const bases = [...read(file).matchAll(/^FROM node:(\S+)/gm)].map((m) => m[1]!);
      expect(bases.length, file).toBeGreaterThan(0);
      for (const base of bases) {
        const version = /^(\d+\.\d+\.\d+)-/.exec(base)?.[1];
        expect(version, `${file}: ${base}`).toBeDefined();
        expect(nodeFloorOf(version!), `${file}: ${base}`).toBeUndefined();
      }
    }
  });

  it('every image build checks its own Node against the floor', () => {
    expect(read('Dockerfile').match(/^RUN node (\S*)node-floor\.ts$/gm)).toHaveLength(2);
    expect(read('scripts/box/Dockerfile')).toMatch(/^RUN node \/usr\/local\/lib\/hopper-client\/node-floor\.ts$/m);
  });

  it('Dependabot bumps the base images of both Dockerfiles', () => {
    const config = read('.github/dependabot.yml');
    for (const dir of ['/', '/scripts/box']) expect(config).toContain(`directory: "${dir}"`);
    expect(config).toContain('package-ecosystem: "docker"');
  });

  it('engines names the floors', () => {
    const want = NODE_FLOORS.map((f, i) => `${i === NODE_FLOORS.length - 1 ? '>=' : '^'}${f.join('.')}`).join(' || ');
    expect(JSON.parse(read('package.json')).engines.node).toBe(want);
    expect(JSON.parse(read('package-lock.json')).packages[''].engines.node).toBe(want);
  });
});
