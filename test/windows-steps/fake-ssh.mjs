#!/usr/bin/env node
/* global process, setInterval, Buffer */
// A fake ssh and scp for the Windows step host's tests (issue #731): it records each call in $FAKE_WIN_DIR/calls.jsonl,
// answers `ssh -G`, keeps the "host's" files under $FAKE_WIN_DIR/host/<drive>/<path>, and "runs" a step script: it
// prints a log line on stdout and one on stderr, writes outputs.tar when the script packs outputs, and exits with
// $FAKE_WIN_EXIT. With $FAKE_WIN_HANG set, a step never ends on its own.
import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const dir = process.env.FAKE_WIN_DIR;
const args = process.argv.slice(2);
const scp = basename(process.argv[1]).includes('scp');
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ tool: scp ? 'scp' : 'ssh', args })}\n`);
const onHost = (remote) => join(dir, 'host', remote.replace(/^[^:]*@[^:]*:/, '').replace(/^([A-Za-z]):/, '$1'));

if (!scp && args[0] === '-G') {
  process.stdout.write('hostname winbox\nuser builder\nport 2222\n');
  process.exit(0);
}
if (scp) {
  const end = args.indexOf('--');
  const paths = args.slice(end + 1);
  const to = paths.at(-1);
  if (to.includes('@')) {
    for (const from of paths.slice(0, -1)) { mkdirSync(onHost(to), { recursive: true }); copyFileSync(from, join(onHost(to), basename(from))); }
  } else {
    try { copyFileSync(onHost(paths[0]), to); } catch { process.stderr.write('scp: no such file\n'); process.exit(1); }
  }
  process.exit(0);
}
const script = Buffer.from(args.at(-1).split(' ').at(-1), 'base64').toString('utf16le');
appendFileSync(join(dir, 'scripts.txt'), `${script}\n----\n`);
if (script.includes('-File')) {
  process.stdout.write('building App.sln\n');
  process.stderr.write('warning CS0168\n');
  const pack = /tar -cf '([^']+)'/.exec(script);
  if (pack) {
    const out = join(dir, 'host', pack[1].replace(/^([A-Za-z]):/, '$1').replaceAll('\\', '/'));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, 'the outputs tar');
  }
  if (process.env.FAKE_WIN_HANG) setInterval(() => undefined, 1000);
  else process.exit(Number(process.env.FAKE_WIN_EXIT ?? 0));
}
