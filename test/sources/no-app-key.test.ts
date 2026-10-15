// GitHub through the sign-in alone (issue #1377): the hopper reads and writes GitHub only with the signed-in user's token
// of the hopper's app. No code path reads, asks for, keeps or uses a GitHub App private key — no variable, no vault row,
// no setup card, no installation token —, and the App source's states are gone with it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PLUGINS } from '../../src/plugins/builtin.ts';

const ROOT = join(import.meta.dirname, '..', '..');
/** The migration that removes the key and the App source names them, once, to remove them. */
const MIGRATION = 'src/store/migration-account-source.ts';

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const code = [...files(join(ROOT, 'src')), ...files(join(ROOT, 'ui', 'src'))]
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
  .filter((f) => f.path !== MIGRATION);

describe('no GitHub App private key (issue #1377)', () => {
  it.each([
    ['the key variable', /GITHUB_APP_PRIVATE_KEY|GITHUB_APP_KEY_VARIABLE/],
    ['the vault row', /github-app-private-key/],
    ['installation tokens', /createAppAuth|@octokit\/auth-app|installationToken|access_tokens/],
    ['the setup route and card', /\/ui\/api\/github-app-key|\/api\/github-apps|github-app-setup|AppKeyField/],
    ['the App source\'s states', /no GitHub App configured|private key not set/],
  ])('no code names %s', (_what, pattern) => {
    expect(code.filter((f) => pattern.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it('no github-app job-source plugin, and no App auth library among the dependencies', () => {
    expect(BUILTIN_PLUGINS.map((p) => p.id)).not.toContain('github-app');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies)).not.toContain('@octokit/auth-app');
  });
});
