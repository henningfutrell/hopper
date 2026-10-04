#!/usr/bin/env node
/* global process */
// A stand-in `ssh` for the herdr CLI client over SSH. Appends its argv to ssh-calls.jsonl, then does
// what sshd does with the command: hands the one string to a real shell (`sh -c`). Target
// `unreachable` fails like ssh itself (exit 255). Never opens a connection.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_HERDR_DIR, 'ssh-calls.jsonl'), JSON.stringify({ argv }) + '\n');

const sep = argv.indexOf('--');
const [target, ...command] = argv.slice(sep + 1);
if (target === 'unreachable') {
  process.stderr.write('ssh: connect to host unreachable port 22: No route to host\n');
  process.exit(255);
}
const r = spawnSync('sh', ['-c', command.join(' ')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
