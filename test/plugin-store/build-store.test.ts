// The default plugin store the Pages site serves (issue #445, design.md "Plugin store"):
// scripts/build-plugin-store.sh builds a bare repository from a checkout's plugin-store.yaml and
// examples/plugins/, on top of the history already published, so an older store install's tree stays in it.
import { execFile } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { git, tempDir } from '../update/support.ts';
import { serveDir } from './support.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'build-plugin-store.sh');
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

function checkout(): string {
  const dir = tempDir('jh-store-src-');
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(ROOT, 'plugin-store.yaml'), join(dir, 'plugin-store.yaml'));
  mkdirSync(join(dir, 'examples'));
  cpSync(join(ROOT, 'examples', 'plugins'), join(dir, 'examples', 'plugins'), { recursive: true });
  return dir;
}

// Async: the store is served from this process, so a blocking call would never get its answer.
const build = (src: string, out: string, previous?: string) => promisify(execFile)('bash', [SCRIPT, src, out, ...(previous ? [previous] : [])]);

describe('scripts/build-plugin-store.sh', () => {
  it('builds a store whose history continues what was published, and adds nothing when nothing changed', async () => {
    const src = checkout();
    const site = tempDir('jh-store-site-');
    cleanups.push(() => rmSync(site, { recursive: true, force: true }));
    const store = join(site, 'plugin-store.git');
    await build(src, store);
    const first = git(store, 'rev-parse', 'HEAD');
    const oldTree = git(store, 'rev-parse', `${first}:examples/plugins/executor/echo-executor`);
    expect(git(store, 'show', `${first}:plugin-store.yaml`)).toMatch(/echo-executor/);
    const served = await serveDir(site);
    cleanups.push(() => served.close());
    const url = `${served.url}/plugin-store.git`;

    const next = join(site, 'next.git');
    await build(src, next, url);
    expect(git(next, 'rev-parse', 'HEAD')).toBe(first);

    writeFileSync(join(src, 'examples', 'plugins', 'executor', 'echo-executor', 'NOTES.md'), 'a change\n');
    await build(src, next, url);
    const second = git(next, 'rev-parse', 'HEAD');
    expect(second).not.toBe(first);
    expect(git(next, 'rev-parse', `${second}^`)).toBe(first);
    expect(git(next, 'cat-file', '-t', oldTree)).toBe('tree');
  });

  it('starts a new history when nothing is published yet', async () => {
    const src = checkout();
    const out = join(tempDir('jh-store-out-'), 'plugin-store.git');
    cleanups.push(() => rmSync(join(out, '..'), { recursive: true, force: true }));
    await build(src, out, 'http://127.0.0.1:9/plugin-store.git');
    expect(git(out, 'rev-list', '--count', 'HEAD')).toBe('1');
  });
});
