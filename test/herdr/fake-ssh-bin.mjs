#!/usr/bin/env node
/* global process */
// A stand-in `ssh` for the herdr CLI client over SSH. `-G <target>` prints a resolved destination as
// `ssh -G` does (host <target>.example, user tester, port 2222; `jumped` has a ProxyJump, `proxied` a
// ProxyCommand). Otherwise it appends its argv to ssh-calls.jsonl, then does what sshd does with the
// command: hands the one string to a real shell (`sh -c`). Destination `unreachable.example` fails
// like ssh itself (exit 255). Never opens a connection.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('-G')) {
  const target = argv.at(-1);
  const host = target.includes('@') ? target.split('@')[1] : target;
  process.stdout.write(`host ${target}\nhostname ${host}.example\nuser tester\nport 2222\nidentityfile ~/.ssh/id_user\n`);
  if (target === 'jumped') process.stdout.write('proxyjump bastion\n');
  if (target === 'proxied') process.stdout.write('proxycommand nc %h %p\n');
  process.exit(0);
}
appendFileSync(join(process.env.FAKE_HERDR_DIR, 'ssh-calls.jsonl'), JSON.stringify({ argv }) + '\n');

const sep = argv.indexOf('--');
const [target, ...command] = argv.slice(sep + 1);
if (target === 'unreachable.example') {
  process.stderr.write('ssh: connect to host unreachable.example port 2222: No route to host\n');
  process.exit(255);
}
const r = spawnSync('sh', ['-c', command.join(' ')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
