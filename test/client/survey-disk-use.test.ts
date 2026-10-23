// The disk a machine's caches and its container storage take, as the survey measures them (issue #2494, design.md "Hopper's
// own disk use" → "Part 6"), run for real: a home of its own with the caches the tools keep, and a fake container runtime
// first on PATH that answers `system df` as docker and podman do.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSurvey, surveyArgv } from '../../src/client/reap.ts';

let root: string;
let home: string;
let bin: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'hopper-disk-use-'));
  home = join(root, 'home');
  bin = join(root, 'bin');
  mkdirSync(home);
  mkdirSync(bin);
  // A runtime that answers nothing, so a real one on this machine is never asked.
  for (const rt of ['docker', 'podman']) writeFileSync(join(bin, rt), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home, XDG_RUNTIME_DIR: root, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` });
function survey(): ReturnType<typeof readSurvey> {
  const [file, ...args] = surveyArgv([]);
  return readSurvey(execFileSync(file!, args, { encoding: 'utf8', env: env(), timeout: 30000 }));
}
function fill(rel: string, kib: number): void {
  mkdirSync(join(home, rel), { recursive: true });
  writeFileSync(join(home, rel, 'blob'), Buffer.alloc(kib * 1024, 1));
}

describe('the caches a survey measured (issue #2494)', () => {
  it('measures each cache the tools keep in the home, by kind and place', () => {
    fill('.nuget/packages', 64);
    fill('.gradle/caches', 128);
    fill('.gradle/wrapper/dists', 32);
    fill('go/pkg/mod', 96);
    fill('.npm', 48);
    fill('.cache/pip', 16);
    const caches = survey()?.caches ?? [];
    expect(caches.map((c) => [c.kind, c.path])).toEqual(expect.arrayContaining([
      ['nuget', join(home, '.nuget/packages')], ['gradle', join(home, '.gradle/caches')], ['gradle', join(home, '.gradle/wrapper/dists')],
      ['go', join(home, 'go/pkg/mod')], ['npm', join(home, '.npm')], ['pip', join(home, '.cache/pip')], ['cache', join(home, '.cache')],
    ]));
    expect(caches.find((c) => c.kind === 'gradle' && c.path.endsWith('caches'))!.bytes).toBeGreaterThanOrEqual(128 * 1024);
    expect(caches.every((c) => c.bytes % 1024 === 0)).toBe(true);
  });

  it('measures no cache that is not there, nor a link, nor anything else in the home', () => {
    fill('.claude/projects', 64);
    mkdirSync(join(root, 'elsewhere'));
    execFileSync('ln', ['-s', join(root, 'elsewhere'), join(home, '.npm')]);
    expect(survey()?.caches).toEqual([]);
  });
});

describe('the container storage a survey measured (issue #2494)', () => {
  it('reads each runtime\'s images, containers, volumes and build cache, with what it could reclaim', () => {
    writeFileSync(join(bin, 'podman'), [
      '#!/bin/sh',
      '[ "$1 $2" = "system df" ] || exit 0',
      'printf "Images|2.5GB|1.2GB (48%%)\\nContainers|512kB|0B (0%%)\\nLocal Volumes|1.07GB|300MB (28%%)\\n"',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(bin, 'docker'), [
      '#!/bin/sh',
      '[ "$1 $2" = "system df" ] || exit 0',
      'printf "Images|0B|0B\\nBuild Cache|3.1GB|3.1GB\\nSomething New|1GB|0B\\n"',
    ].join('\n'), { mode: 0o755 });
    expect(survey()?.storage).toEqual([
      { runtime: 'docker', kind: 'images', bytes: 0, reclaimableBytes: 0 },
      { runtime: 'docker', kind: 'build-cache', bytes: 3.1e9, reclaimableBytes: 3.1e9 },
      { runtime: 'podman', kind: 'images', bytes: 2.5e9, reclaimableBytes: 1.2e9 },
      { runtime: 'podman', kind: 'containers', bytes: 512e3, reclaimableBytes: 0 },
      { runtime: 'podman', kind: 'volumes', bytes: 1.07e9, reclaimableBytes: 300e6 },
    ]);
  });

  it('says none where no runtime answers', () => {
    expect(survey()?.storage).toEqual([]);
  });
});
