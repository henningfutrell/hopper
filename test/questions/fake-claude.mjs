#!/usr/bin/env node
/* global process, setInterval */
// Fake `claude` executable. Records argv, stdin, env and cwd to $FAKE_CLAUDE_OUT (JSON), then
// behaves per $FAKE_CLAUDE_MODE: ok (default) | malformed | invalid | exit1 | hang.
import { writeFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({
    argv: process.argv.slice(2), stdin, env: process.env, cwd: process.cwd(),
  }));
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'exit1') { process.stderr.write('auth failed'); process.exit(1); }
  if (mode === 'malformed') { process.stdout.write('not json {'); return; }
  if (mode === 'invalid') {
    process.stdout.write(JSON.stringify({ type: 'result', structured_output: { answer: 'x', confident: 'yes' } }));
    return;
  }
  process.stdout.write(JSON.stringify({
    type: 'result', is_error: false, result: '',
    structured_output: { answer: 'use postgres', confident: true, risky: false, reason: 'rules' },
  }));
});
