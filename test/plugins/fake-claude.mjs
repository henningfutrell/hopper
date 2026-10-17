#!/usr/bin/env node
/* global process, setInterval */
// Fake `claude` executable. Records argv, stdin, env and cwd to $FAKE_CLAUDE_OUT (JSON), then
// behaves per $FAKE_CLAUDE_MODE: ok (default) | malformed | invalid | exit1 | hang. In `ok` mode
// the structured_output is $FAKE_CLAUDE_STRUCTURED (JSON) when set, else a level's answer, and
// modelUsage names `claude-<--model>-resolved`, as the real CLI names the model an alias ran.
// With `--input-format stream-json` it answers the initialize control request on stdin with the
// models it offers: $FAKE_CLAUDE_MODELS (JSON) when set, else two.
// With $FAKE_CLAUDE_LITTER set it leaves what a real run leaves (issue #472): a file in its cwd, and its project dir
// under ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects, named for the cwd. With it `stuck`, also a file in a dir it may
// not change, so the run dir cannot be removed.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { stdin += c; });
process.stdin.on('end', () => {
  writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({
    argv: process.argv.slice(2), stdin, env: process.env, cwd: process.cwd(), pid: process.pid,
  }));
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';
  if (process.env.FAKE_CLAUDE_LITTER) {
    writeFileSync(join(process.cwd(), 'session.jsonl'), '{}');
    const project = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'session.jsonl'), '{}');
    if (process.env.FAKE_CLAUDE_LITTER === 'stuck') {
      mkdirSync(join(process.cwd(), 'stuck'));
      writeFileSync(join(process.cwd(), 'stuck', 'session.jsonl'), '{}');
      chmodSync(join(process.cwd(), 'stuck'), 0o500);
    }
  }
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
  // `device-code`, `device-code-fails` (issue #476): the run waits on a gh login, as `gh auth login` prints it; then it answers, or fails.
  if (mode === 'device-code' || mode === 'device-code-fails') {
    process.stderr.write('! First copy your one-time code: WDJB-MJHT\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
    if (mode === 'device-code-fails') { process.stderr.write('gh: the code WDJB-MJHT expired'); process.exit(1); }
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
      : { answer: 'use postgres', escalate: false, reason: 'rules', confidence: 'high' },
  }));
});
