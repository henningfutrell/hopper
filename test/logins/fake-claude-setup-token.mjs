#!/usr/bin/env node
/* global process */
// Fake `claude` for `claude setup-token` (issue #1287): like the real CLI it prints nothing and waits when its stdout is no
// terminal, so only a run in a pseudo-terminal sees its URL. In a terminal it puts stdin in raw mode, prints its URL as an
// OSC 8 link (the real CLI's form), and reads the code up to Enter (\r). The right code prints the token; any other an error.
// $FAKE_SETUP_DIR controls and records it:
//   code        the code it takes (default good-code)
//   token       the token it prints (default below)
//   calls.jsonl one line per run: { argv, home, columns, tty, oauthToken } (oauthToken: CLAUDE_CODE_OAUTH_TOKEN was set)
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.env.FAKE_SETUP_DIR;
const argv = process.argv.slice(2);
const read = (name, fallback) => (dir && existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : fallback);
if (dir) appendFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ argv, home: process.env.HOME, columns: process.stdout.columns ?? null, tty: Boolean(process.stdout.isTTY), oauthToken: Boolean(process.env.CLAUDE_CODE_OAUTH_TOKEN) })}\n`);

if (argv[0] !== 'setup-token') { process.stderr.write('fake: setup-token only\n'); process.exit(2); }
// No terminal: the real CLI renders nothing, and waits.
if (!process.stdout.isTTY) setInterval(() => undefined, 60_000);
else {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=fake&response_type=code&state=fake-state';
  process.stdout.write('\x1b[1mWelcome to Claude Code\x1b[0m\r\n');
  process.stdout.write('This will guide you through long-lived (1-year) auth token setup for your Claude account.\r\n');
  process.stdout.write(`Browser didn't open? Use the url below to sign in (c to copy)\r\n\x1b]8;id=1;${url}\x07${url}\x1b]8;;\x07\r\n`);
  process.stdout.write('Paste code here if prompted > ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  let input = '';
  process.stdin.on('data', (c) => {
    input += c;
    const at = input.indexOf('\r');
    if (at < 0) return;
    const code = input.slice(0, at).trim();
    if (code === read('code', 'good-code')) {
      const token = read('token', 'sk-ant-oat01-FakeSetupToken_0123456789abcdefABCDEF-xyz');
      process.stdout.write(`\r\n\x1b[32m✓\x1b[0m Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\x1b[33m${token}\x1b[0m\r\n\r\nStore this token securely. You won't be able to see it again.\r\n`);
      process.exit(0);
    }
    process.stdout.write('\r\nOAuth error: Request failed with status code 400\r\n');
    process.exit(1);
  });
}
