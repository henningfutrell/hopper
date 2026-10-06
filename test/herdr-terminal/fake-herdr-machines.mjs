#!/usr/bin/env node
/* global process */
// A stand-in `herdr` for the herdr terminal's machine sync: `machine list --json`, `machine add`,
// `machine remove` over a catalog file in $FAKE_HERDR_DIR; every call appended to calls.jsonl with
// the variables the sync must set. A target containing `unreachable` fails to add, as herdr does.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_HERDR_DIR;
const argv = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ argv, state: process.env.XDG_STATE_HOME, path0: (process.env.PATH ?? '').split(':')[0], herdrEnv: Object.keys(process.env).filter((k) => k.startsWith('HERDR')) }) + '\n');
const file = join(dir, 'catalog.json');
const catalog = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
const save = () => writeFileSync(file, JSON.stringify(catalog));
const flag = (name) => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };

if (argv.join(' ') === 'machine list --json') process.stdout.write(JSON.stringify(catalog.map((m) => ({ ...m, enabled: true, selected: false }))));
else if (argv[0] === 'machine' && argv[1] === 'remove') {
  const i = catalog.findIndex((m) => m.id === argv[2]);
  if (i < 0) { process.stderr.write(`error: no saved machine ${argv[2]}\n`); process.exit(1); }
  catalog.splice(i, 1); save();
  process.stdout.write(`Removed SSH machine ${argv[2]}.\n`);
} else if (argv[0] === 'machine' && argv[1] === 'add') {
  const target = argv[2];
  if (target.includes('unreachable') || target.includes('192.0.2.99')) { process.stderr.write('error: remote platform detection failed: ssh: connect to host 192.0.2.99 port 22: Connection timed out; machine was not saved\n'); process.exit(1); }
  const id = `id${catalog.length}${Date.now() % 1000}`;
  catalog.push({ id, label: flag('--label'), target, session: flag('--remote-session') }); save();
  process.stdout.write(`Saved SSH machine ${id}. Remote server is ready.\n`);
} else { process.stderr.write(`fake herdr: unexpected ${argv.join(' ')}\n`); process.exit(2); }
