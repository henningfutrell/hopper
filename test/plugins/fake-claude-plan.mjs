#!/usr/bin/env node
/* global process */
// Fake `claude` for the claude-plan usage source. $FAKE_PLAN_DIR controls it and records it:
//   mode        ok (default) | header-only | is-error | exit1 | not-json | logged-out
//   result.txt  the `/usage` panel text (default: three windows, below)
//   calls.jsonl one line per run: { argv, cwd }
// `-p /usage --output-format json` prints the envelope `claude -p` prints; `auth status --json`
// prints the auth JSON. Like the real CLI, a `-p` run leaves a project directory under
// $HOME/.claude/projects/<cwd with every non-alphanumeric as ->/, which the plugin must remove.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_PLAN_DIR;
const argv = process.argv.slice(2);
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv, cwd: process.cwd() })}\n`);
const read = (name, fallback) => (dir && existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : fallback);
const mode = read('mode', 'ok');

const DEFAULT_RESULT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 80% used · resets Oct 3, 12:15pm (America/Chicago)',
  'Current week (all models): 30% used · resets Oct 6, 12pm (America/Chicago)',
  'Current week (Fable): 99% used · resets Oct 6, 12pm (America/Chicago)',
  '',
  "What's contributing to your limits usage?",
].join('\n');

if (argv[0] === '--version') {
  process.stdout.write('9.9.9 (fake claude-plan)\n');
  process.exit(0);
}
if (mode === 'exit1') {
  process.stderr.write('fake: not logged in');
  process.exit(1);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = mode !== 'logged-out';
  process.stdout.write(JSON.stringify(loggedIn
    ? { loggedIn, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'user@example.com', orgId: 'org-1', orgName: 'Example Org', subscriptionType: 'max', accessToken: 'sk-ant-SECRET' }
    : { loggedIn }));
  process.exit(loggedIn ? 0 : 1);
}
if (argv[0] === '-p' && argv[1] === '/usage') {
  const project = join(process.env.HOME, '.claude', 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(join(project, 'memory'), { recursive: true });
  writeFileSync(join(project, 'transcript.jsonl'), '{}\n');
  if (mode === 'not-json') { process.stdout.write('Error: something {'); process.exit(0); }
  const result = mode === 'header-only' ? 'You are currently using your subscription to power your Claude Code usage' : read('result.txt', DEFAULT_RESULT);
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: mode === 'is-error', num_turns: 0, total_cost_usd: 0, result: mode === 'is-error' ? 'Usage is not available right now' : result, local_command: 'usage' }));
  process.exit(0);
}
process.stderr.write(`fake claude-plan: unexpected argv ${JSON.stringify(argv)}`);
process.exit(2);
