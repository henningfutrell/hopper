#!/usr/bin/env node
/* global process */
// A fake ssh for the Podman host's tests (issue #2272 part 2): it records each call in $FAKE_SSH_DIR/calls.jsonl, answers
// `ssh -G`, and "runs" `podman system dial-stdio`: it joins its stdin and stdout to the libpod double's socket
// ($FAKE_PODMAN_SOCKET), as dial-stdio joins them to the host's Podman socket. With $FAKE_SSH_FAIL set, it says why on
// stderr and exits 255, as ssh does when it cannot connect. With $FAKE_SSH_DROP_WAIT set, the first call that waits for a
// box drops before it reaches Podman: the connection of a long wait that went away.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';

const dir = process.env.FAKE_SSH_DIR;
const args = process.argv.slice(2);
appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify(args)}\n`);
if (args[0] === '-G') {
  process.stdout.write('hostname box-vm\nuser sandbox\nport 22\n');
  process.exit(0);
}
if (process.env.FAKE_SSH_FAIL) {
  process.stderr.write('sandbox@box-vm: Permission denied (publickey).\n');
  process.exit(255);
}
const socket = connect(process.env.FAKE_PODMAN_SOCKET);
let first = true;
process.stdin.on('data', (d) => {
  if (first && process.env.FAKE_SSH_DROP_WAIT && d.toString('latin1').includes('/wait?') && !existsSync(join(dir, 'dropped'))) {
    writeFileSync(join(dir, 'dropped'), '');
    process.stderr.write('Connection to box-vm closed by remote host.\n');
    process.exit(255);
  }
  first = false;
  socket.write(d);
});
process.stdin.on('end', () => socket.end());
socket.on('data', (d) => process.stdout.write(d));
socket.on('end', () => process.exit(0));
socket.on('error', (e) => { process.stderr.write(`dial-stdio: ${e.message}\n`); process.exit(1); });
