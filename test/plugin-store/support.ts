// A plugin store for tests: a real git repository in a temp dir holding a store catalogue and
// plugin directories copied from examples/plugins (design.md "Plugin store").
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { git } from '../update/support.ts';

export const EXAMPLES = join(import.meta.dirname, '..', '..', 'examples', 'plugins');

export interface CatalogueEntry { id: string; role: string; describe: string; path: string }

export interface StoreRepo {
  dir: string;
  /** Write the catalogue and commit everything; returns the sha. */
  commit(subject: string, plugins: CatalogueEntry[]): string;
  /** Copy examples/plugins/<role>/<id> to `path` in the repository (not committed). */
  addExample(role: string, id: string, path?: string): string;
  /** Write a file in the repository (not committed). */
  write(path: string, text: string): void;
  remove(path: string): void;
}

export const entry = (role: string, id: string, describe = `the ${id} example`): CatalogueEntry => ({ id, role, describe, path: `plugins/${id}` });

export function createStoreRepo(root: string): StoreRepo {
  const dir = join(root, 'plugin-store');
  mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  const repo: StoreRepo = {
    dir,
    commit(subject, plugins) {
      writeFileSync(join(dir, 'plugin-store.yaml'), stringify({ version: 1, plugins }));
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '--allow-empty', '-m', subject);
      return git(dir, 'rev-parse', 'HEAD');
    },
    addExample(role, id, path = `plugins/${id}`) {
      cpSync(join(EXAMPLES, role, id), join(dir, path), { recursive: true });
      return path;
    },
    write(path, text) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), text);
    },
    remove(path) { rmSync(join(dir, path), { recursive: true, force: true }); },
  };
  return repo;
}
