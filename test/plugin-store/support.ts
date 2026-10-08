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

/** Serve `dir` as plain files on loopback, as the Pages site serves the default plugin store. */
export async function serveDir(dir: string): Promise<{ url: string; close(): Promise<void> }> {
  const { createServer } = await import('node:http');
  const { readFile } = await import('node:fs/promises');
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path.includes('..')) { res.writeHead(400).end(); return; }
    readFile(join(dir, path)).then((b) => res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(b), () => res.writeHead(404).end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
