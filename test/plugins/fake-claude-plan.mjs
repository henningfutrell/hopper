#!/usr/bin/env node
/* global process */
// Fake `claude` for the claude-plan usage source. $FAKE_PLAN_DIR controls it and records it:
//   mode        ok (default) | header-only | is-error | exit1 | not-json | logged-out | token-only
//               (token-only: no sign-in of its own, signed in only with CLAUDE_CODE_OAUTH_TOKEN, as a lane pod; issue #1287)
//   result.txt  the `/usage` panel text (default: three windows, below)
//   calls.jsonl one line per run: { argv, cwd }, and token: true when CLAUDE_CODE_OAUTH_TOKEN is set
//   login-code  the code `auth login` takes (default good-code); taken, it writes mode ok (issue #1128)
//   email, org  the account `auth status` says it is signed in as (default user@example.com, Example Org; issue #1269)
// `-p /usage --output-format json` prints the envelope `claude -p` prints; `auth status --json`
// prints the auth JSON. `auth login` prints its URL as the real CLI does, reads the code on stdin, and signs in or not. Like the real CLI, a `-p` run leaves a project directory under
// $HOME/.claude/projects/<cwd with every non-alphanumeric as ->/, which the plugin must remove.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_PLAN_DIR;
const argv = process.argv.slice(2);
const token = Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN);
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv, cwd: process.cwd(), ...(token ? { token } : {}) })}\n`);
const read = (name, fallback) => (dir && existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : fallback);
const asked = read('mode', 'ok');
// Signed in with the token, claude says so as `oauth_token`, with no account of its own.
const mode = asked === 'token-only' ? (token ? 'token' : 'exit1') : asked;

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
if (argv[0] === 'auth' && argv[1] === 'login') {
  if (mode === 'login-no-url') { process.stderr.write('fake: cannot sign in here\n'); process.exit(1); }
  process.stdout.write("Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&state=fake\nPaste code here if prompted > ");
  let input = '';
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    if (code === read('login-code', 'good-code')) {
      if (dir) writeFileSync(join(dir, 'mode'), 'ok');
      process.stdout.write('Login successful.\n');
      process.exit(0);
    }
    process.stdout.write('Login failed: Request failed with status code 400\n');
    process.exit(1);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { input += c; if (input.includes('\n')) finish(input.split('\n')[0].trim()); });
  process.stdin.on('end', () => finish(input.trim()));
} else {
if (mode === 'exit1') {
  process.stderr.write('fake: not logged in');
  process.exit(1);
}
if (argv[0] === 'auth' && argv[1] === 'status' && mode === 'token') {
  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }));
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = mode !== 'logged-out';
  process.stdout.write(JSON.stringify(loggedIn
    ? { loggedIn, authMethod: 'claude.ai', apiProvider: 'firstParty', email: read('email', 'user@example.com'), orgId: 'org-1', orgName: read('org', 'Example Org'), subscriptionType: 'max', accessToken: 'sk-ant-SECRET' }
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
}
