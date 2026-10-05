// The store catalogue (design.md "Plugin store"): plugin-store.yaml parsed and checked, pure.
import { describe, expect, it } from 'vitest';
import { parseCatalogue } from '../../src/plugins/plugin-store-catalogue.ts';

const ok = (text: string) => {
  const r = parseCatalogue(text);
  if ('error' in r) throw new Error(r.error);
  return r.plugins;
};
const error = (text: string) => {
  const r = parseCatalogue(text);
  return 'error' in r ? r.error : undefined;
};

describe('the store catalogue', () => {
  it('reads every entry, in order', () => {
    expect(ok('version: 1\nplugins:\n  - { id: a, role: executor, describe: A, path: plugins/a }\n  - { id: b-2, role: router, describe: B, path: b }\n'))
      .toEqual([{ id: 'a', role: 'executor', describe: 'A', path: 'plugins/a' }, { id: 'b-2', role: 'router', describe: 'B', path: 'b' }]);
  });

  it('takes an empty list', () => {
    expect(ok('version: 1\nplugins: []\n')).toEqual([]);
  });

  it.each([
    ['not YAML', 'plugins: [', /plugin-store\.yaml/],
    ['no version', 'plugins: []\n', /version/],
    ['another version', 'version: 2\nplugins: []\n', /version/],
    ['a bad id', 'version: 1\nplugins:\n  - { id: Bad, role: executor, describe: x, path: p }\n', /id/],
    ['an unknown role', 'version: 1\nplugins:\n  - { id: a, role: painter, describe: x, path: p }\n', /role/],
    ['a path out of the repository', 'version: 1\nplugins:\n  - { id: a, role: executor, describe: x, path: ../p }\n', /path/],
    ['an absolute path', 'version: 1\nplugins:\n  - { id: a, role: executor, describe: x, path: /p }\n', /path/],
    ['the root', 'version: 1\nplugins:\n  - { id: a, role: executor, describe: x, path: . }\n', /path/],
    ['an unknown key', 'version: 1\nplugins:\n  - { id: a, role: executor, describe: x, path: p, run: x }\n', /run/],
    ['a repeated id', 'version: 1\nplugins:\n  - { id: a, role: executor, describe: x, path: p }\n  - { id: a, role: router, describe: y, path: q }\n', /a.*twice|twice.*a/],
  ])('refuses %s', (_, text, why) => {
    expect(error(text)).toMatch(why);
  });
});
