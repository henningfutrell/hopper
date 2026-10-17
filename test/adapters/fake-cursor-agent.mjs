#!/usr/bin/env node
/* global process, setInterval */
// A stand-in `cursor-agent` (Cursor's CLI agent) in print mode. Appends its argv, cwd and the
// environment the hopper sets to cursor-calls.jsonl in $FAKE_CURSOR_DIR, then answers as
// `cursor-agent -p --output-format json` does: one JSON result object. The reply is
// $FAKE_CURSOR_REPLY; $FAKE_CURSOR_MODE `exit1` fails as an unauthenticated CLI does, `error` answers
// an error result, `hang` never answers. $FAKE_CURSOR_REPLIES (a JSON array) gives the reply of each
// call in turn, counted in cursor-calls.jsonl; past its end the last one. Like the real one, it keeps the chat in
// <config dir>/chats/<md5 of its cwd> (issue #474: a draft removes it) and its project data under $CURSOR_DATA_DIR.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_CURSOR_DIR, 'cursor-calls.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), env: { TMPDIR: process.env.TMPDIR, HOPPER_JOB_ID: process.env.HOPPER_JOB_ID, HOPPER_REPO: process.env.HOPPER_REPO, HOPPER_URL: process.env.HOPPER_URL, CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR },
}) + '\n');
if (process.env.FAKE_CURSOR_KEEP) {
  const config = process.env.CURSOR_CONFIG_DIR || (process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'cursor') : join(homedir(), '.cursor'));
  const chat = join(config, 'chats', createHash('md5').update(process.cwd()).digest('hex'));
  mkdirSync(chat, { recursive: true });
  writeFileSync(join(chat, 'store.db'), 'chat');
  const data = join(process.env.CURSOR_DATA_DIR || join(homedir(), '.cursor'), 'projects', 'run');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'worker.log'), 'log');
}
const mode = process.env.FAKE_CURSOR_MODE ?? 'ok';
if (mode === 'hang') setInterval(() => {}, 1000);
else if (mode === 'exit1') {
  process.stderr.write("Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.\n");
  process.exit(1);
} else {
  const resumed = argv.indexOf('--resume');
  const replies = process.env.FAKE_CURSOR_REPLIES ? JSON.parse(process.env.FAKE_CURSOR_REPLIES) : undefined;
  const calls = readFileSync(join(process.env.FAKE_CURSOR_DIR, 'cursor-calls.jsonl'), 'utf8').trim().split('\n').length;
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: mode === 'error' ? 'error' : 'success', is_error: mode === 'error', duration_ms: 5,
    result: replies ? replies[Math.min(calls, replies.length) - 1] : (process.env.FAKE_CURSOR_REPLY ?? ''), session_id: resumed >= 0 ? argv[resumed + 1] : 'chat-1', request_id: 'r-1',
  }) + '\n');
}
