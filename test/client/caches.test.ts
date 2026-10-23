// The cache clear (issue #2494, design.md "Hopper's own disk use" → "Part 10"), run for real in a home made for the test:
// it removes the places of the kinds asked, and nothing else of the home — never Claude's files, the rest of `~/.cache`, or
// a place that is a link. The script runs with a PATH of only the tools it needs and a fake pkill, so no real process is
// stopped.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cachesArgv, cachesArgvOf, CLEARED_KINDS, readCaches } from '../../src/client/caches.ts';
import { CACHE_DIRS } from '../../src/client/reap.ts';
import { CAPPED_KINDS } from '../../src/domain/cache-caps.ts';

const TOOLS = ['sh', 'rm', 'chmod', 'id', 'timeout'];
// The fake pkill: each call goes to $FAKE/calls.
const FAKE_PKILL = '#!/bin/sh\necho "pkill $*" >> "$FAKE/calls"\n';

let fake: string, home: string, bin: string;
beforeEach(() => {
  fake = mkdtempSync(join(tmpdir(), 'hopper-caches-'));
  home = join(fake, 'home');
  bin = join(fake, 'bin');
  mkdirSync(bin);
  for (const t of TOOLS) {
    const at = execFileSync('sh', ['-c', `command -v ${t}`], { encoding: 'utf8' }).trim();
    if (at.startsWith('/')) symlinkSync(at, join(bin, t));
  }
  writeFileSync(join(bin, 'pkill'), FAKE_PKILL, { mode: 0o755 });
  writeFileSync(join(fake, 'calls'), '');
  for (const [, rel] of CACHE_DIRS) {
    mkdirSync(join(home, rel, 'x'), { recursive: true });
    writeFileSync(join(home, rel, 'x', 'f'), 'cached');
  }
  for (const keep of ['.claude/projects', '.cache/other', '.gradle/gradle.properties.d']) {
    mkdirSync(join(home, keep), { recursive: true });
    writeFileSync(join(home, keep, 'f'), 'keep');
  }
  writeFileSync(join(home, '.claude.json'), '{}');
});
afterEach(() => {
  execFileSync('chmod', ['-R', 'u+w', fake]);
  rmSync(fake, { recursive: true, force: true });
});

const run = (argv: string[], h = home): string => {
  const [cmd, ...args] = argv;
  return execFileSync(cmd!, args, { encoding: 'utf8', env: { PATH: bin, HOME: h, FAKE: fake } });
};
const there = (rel: string): boolean => existsSync(join(home, rel));

describe('the cache clear (issue #2494)', () => {
  it('knows the same kinds as the domain', () => {
    expect([...CLEARED_KINDS].sort()).toEqual([...CAPPED_KINDS].sort());
  });

  it('removes the places of the kinds asked, and says each one', () => {
    const said = readCaches(run(cachesArgv(['npm', 'pip'])));
    expect(said).toEqual({ removed: [{ kind: 'npm', path: join(home, '.npm') }, { kind: 'pip', path: join(home, '.cache/pip') }] });
    expect(there('.npm')).toBe(false);
    expect(there('.cache/pip')).toBe(false);
    expect(there('.nuget/packages')).toBe(true);
    expect(there('go/pkg/mod')).toBe(true);
  });

  it('never touches Claude\'s files, the rest of ~/.cache or the home\'s other files', () => {
    run(cachesArgv([...CLEARED_KINDS]));
    for (const [, rel] of CACHE_DIRS) expect(there(rel)).toBe(false);
    expect(readFileSync(join(home, '.claude/projects/f'), 'utf8')).toBe('keep');
    expect(there('.claude.json')).toBe(true);
    expect(there('.cache/other/f')).toBe(true);
    expect(there('.gradle/gradle.properties.d/f')).toBe(true);
  });

  it('removes Go\'s module cache, which Go makes read-only', () => {
    chmodSync(join(home, 'go/pkg/mod/x'), 0o555);
    chmodSync(join(home, 'go/pkg/mod/x/f'), 0o444);
    expect(readCaches(run(cachesArgv(['go'])))!.removed.map((r) => r.path)).toEqual([join(home, 'go/pkg/mod'), join(home, '.cache/go-build')]);
    expect(there('go/pkg/mod')).toBe(false);
  });

  it('stops the Gradle daemons first, and only for Gradle', () => {
    run(cachesArgv(['npm']));
    expect(readFileSync(join(fake, 'calls'), 'utf8')).toBe('');
    run(cachesArgv(['gradle']));
    expect(readFileSync(join(fake, 'calls'), 'utf8')).toMatch(/^pkill -u \d+ -f org\[\.\]gradle.*GradleDaem\[o\]n\n$/);
    expect(there('.gradle/caches')).toBe(false);
    expect(there('.gradle/wrapper/dists')).toBe(false);
  });

  it('leaves a place that is a link, and what it points at', () => {
    const elsewhere = join(fake, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'f'), 'mine');
    rmSync(join(home, '.npm'), { recursive: true });
    symlinkSync(elsewhere, join(home, '.npm'));
    expect(readCaches(run(cachesArgv(['npm'])))).toEqual({ removed: [] });
    expect(readFileSync(join(elsewhere, 'f'), 'utf8')).toBe('mine');
  });

  it('refuses a home that is the root', () => {
    expect(() => run(cachesArgv(['npm']), '/')).toThrow();
  });

  it('takes from a request only kinds it knows', () => {
    expect(cachesArgvOf({ kinds: ['npm'] })).toEqual(cachesArgv(['npm']));
    expect(cachesArgvOf({ kinds: ['cache'] })).toMatch(/^kinds must be/);
    expect(cachesArgvOf({ kinds: ['npm; rm -rf ~'] })).toMatch(/^kinds must be/);
    expect(cachesArgvOf({ kinds: [] })).toMatch(/^kinds must be/);
    expect(cachesArgvOf({})).toMatch(/^kinds must be/);
  });

  it('says nothing for output that did not finish', () => {
    expect(readCaches('hopper-cache-cleared|npm|/h/.npm\n')).toBeUndefined();
  });
});
