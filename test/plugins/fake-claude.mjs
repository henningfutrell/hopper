#!/usr/bin/env node
/* global process, setInterval */
// Fake `claude` executable. Records argv, stdin, env and cwd to $FAKE_CLAUDE_OUT (JSON), then
// behaves per $FAKE_CLAUDE_MODE: ok (default) | malformed | invalid | exit1 | hang. In `ok` mode
// the structured_output is $FAKE_CLAUDE_STRUCTURED (JSON) when set, else a level's answer, and
// modelUsage names `claude-<--model>-resolved`, as the real CLI names the model an alias ran.
// With `--input-format stream-json` it answers the initialize control request on stdin with the
// models it offers: $FAKE_CLAUDE_MODELS (JSON) when set, else two.
import { writeFileSync } from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({
    argv: process.argv.slice(2), stdin, env: process.env, cwd: process.cwd(),
  }));
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
  if (process.argv.includes('--input-format')) {
    if (mode === 'exit1') process.exit(1);
    const models = process.env.FAKE_CLAUDE_MODELS ? JSON.parse(process.env.FAKE_CLAUDE_MODELS) : [
      { value: 'opus', resolvedModel: 'claude-opus-x', displayName: 'Opus X', description: 'complex work' },
      { value: 'haiku', resolvedModel: 'claude-haiku-x', displayName: 'Haiku X', description: 'quick answers' },
    ];
    const { request_id } = JSON.parse(stdin.split('\n')[0]);
    process.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n`);
    process.stdout.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response: { models } } })}\n`);
    return;
  }
  if (mode === 'hang') { setInterval(() => {}, 1000); return; }
  if (mode === 'exit1') { process.stderr.write('auth failed'); process.exit(1); }
  if (mode === 'malformed') { process.stdout.write('not json {'); return; }
  if (mode === 'invalid') {
    process.stdout.write(JSON.stringify({ type: 'result', structured_output: { answer: 'x', escalate: 'no' } }));
    return;
  }
  process.stdout.write(JSON.stringify({
    type: 'result', is_error: false, result: '',
    modelUsage: { [`claude-${process.argv[process.argv.indexOf('--model') + 1]}-resolved`]: { outputTokens: 1 } },
    structured_output: process.env.FAKE_CLAUDE_STRUCTURED
      ? JSON.parse(process.env.FAKE_CLAUDE_STRUCTURED)
      : { answer: 'use postgres', escalate: false, reason: 'rules' },
  }));
});
