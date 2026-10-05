#!/usr/bin/env node
/* global process, setInterval */
// A stand-in `cursor-agent` (Cursor's CLI agent) in print mode. Appends its argv, cwd and the
// environment the hopper sets to cursor-calls.jsonl in $FAKE_CURSOR_DIR, then answers as
// `cursor-agent -p --output-format json` does: one JSON result object. The reply is
// $FAKE_CURSOR_REPLY; $FAKE_CURSOR_MODE `exit1` fails as an unauthenticated CLI does, `error` answers
// an error result, `hang` never answers. $FAKE_CURSOR_REPLIES (a JSON array) gives the reply of each
// call in turn, counted in cursor-calls.jsonl; past its end the last one.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_CURSOR_DIR, 'cursor-calls.jsonl'), JSON.stringify({
  argv, cwd: process.cwd(), env: { TMPDIR: process.env.TMPDIR, HOPPER_JOB_ID: process.env.HOPPER_JOB_ID, HOPPER_REPO: process.env.HOPPER_REPO },
}) + '\n');
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
