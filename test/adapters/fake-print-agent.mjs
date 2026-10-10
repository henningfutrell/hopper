#!/usr/bin/env node
/* global process, setInterval */
// A stand-in for the agent CLIs the print-mode executors run (issue #307): `codex exec --json`,
// `opencode run --format json`, `omp -p --mode json` and `claude -p --output-format json` (issue #533), chosen by $FAKE_AGENT_KIND. Appends its argv,
// cwd and the environment the hopper sets to agent-calls.jsonl in $FAKE_AGENT_DIR, then answers as that
// CLI does — JSON events, one per line, in the shapes each prints (taken from the real CLIs, 2026-10-07).
// The reply is $FAKE_AGENT_REPLY; $FAKE_AGENT_REPLIES (a JSON array) gives the reply of each call in
// turn. $FAKE_AGENT_MODE `error` answers the CLI's own error, `hang` never answers. Like the real CLIs, it
// reads stdin to its end first.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// As the real codex and opencode do when stdin is not a terminal: read it to its end before the turn.
// A turn that hands the CLI an open stdin never starts (found on the agent boxes, issue #307).
if (!process.stdin.isTTY) readFileSync(0);

const argv = process.argv.slice(2);
const log = join(process.env.FAKE_AGENT_DIR, 'agent-calls.jsonl');
appendFileSync(log, JSON.stringify({
  argv, cwd: process.cwd(),
  env: { TMPDIR: process.env.TMPDIR, HOPPER_JOB_ID: process.env.HOPPER_JOB_ID, HOPPER_REPO: process.env.HOPPER_REPO, HOPPER_URL: process.env.HOPPER_URL },
}) + '\n');
const kind = process.env.FAKE_AGENT_KIND;
const mode = process.env.FAKE_AGENT_MODE ?? 'ok';
const calls = readFileSync(log, 'utf8').trim().split('\n').length;
const replies = process.env.FAKE_AGENT_REPLIES ? JSON.parse(process.env.FAKE_AGENT_REPLIES) : undefined;
const reply = replies ? replies[Math.min(calls, replies.length) - 1] : (process.env.FAKE_AGENT_REPLY ?? '');
const after = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// `leave`, `escape`: what a careless turn leaves (issue #410): a temp file, and a process that left its session,
// named $FAKE_AGENT_LEFTOVER — with `escape`, one that cleared its environment too.
if (mode === 'leave' || mode === 'escape') {
  writeFileSync(join(process.env.TMPDIR, 'left.txt'), 'x');
  spawn('setsid', ['sh', '-c', `exec -a ${process.env.FAKE_AGENT_LEFTOVER} sleep 300`], { detached: true, stdio: 'ignore', env: mode === 'escape' ? {} : process.env }).unref();
}
// `device-code`, `device-code-fails` (issue #476): a tool of the agent's waits on a login and prints codex's device
// code, as `codex login --device-auth` does; the turn then answers as usual, or its CLI fails.
if (mode === 'device-code' || mode === 'device-code-fails') {
  process.stderr.write('Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   ABCD-EFGHJ\n\n');
  if (mode === 'device-code-fails') { process.stderr.write('login timed out; the code was ABCD-EFGHJ\n'); process.exit(1); }
}
if (mode === 'hang') setInterval(() => {}, 1000);
else if (kind === 'codex') {
  // `codex exec resume … -- <thread id> <prompt>` resumes; `codex exec … -- <prompt>` starts a thread.
  const thread = argv[1] === 'resume' ? argv[argv.indexOf('--') + 1] : 'thread-1';
  out({ type: 'thread.started', thread_id: thread });
  out({ type: 'turn.started' });
  if (mode === 'error') {
    out({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } });
    process.exit(1);
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Looking at it.' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: '', exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: reply } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
} else if (kind === 'opencode') {
  const session = after('--session') ?? 'ses_1';
  if (mode === 'error') {
    out({ type: 'error', timestamp: 1, sessionID: session, error: { name: 'APIError', data: { message: 'Not Found', statusCode: 404 } } });
    process.exit(1);
  }
  // Two steps: the agent's earlier text, a tool, then its last message — the answer.
  out({ type: 'step_start', timestamp: 1, sessionID: session, part: { id: 'p1', messageID: 'msg_1', sessionID: session, type: 'step-start' } });
  out({ type: 'text', timestamp: 2, sessionID: session, part: { id: 'p2', messageID: 'msg_1', sessionID: session, type: 'text', text: 'Looking at it.' } });
  out({ type: 'step_finish', timestamp: 3, sessionID: session, part: { id: 'p3', messageID: 'msg_1', sessionID: session, type: 'step-finish', reason: 'tool-calls' } });
  out({ type: 'step_start', timestamp: 4, sessionID: session, part: { id: 'p4', messageID: 'msg_2', sessionID: session, type: 'step-start' } });
  const [head, ...rest] = reply.split('\n');
  out({ type: 'text', timestamp: 5, sessionID: session, part: { id: 'p5', messageID: 'msg_2', sessionID: session, type: 'text', text: head } });
  if (rest.length) out({ type: 'text', timestamp: 6, sessionID: session, part: { id: 'p6', messageID: 'msg_2', sessionID: session, type: 'text', text: `\n${rest.join('\n')}` } });
  out({ type: 'step_finish', timestamp: 7, sessionID: session, part: { id: 'p7', messageID: 'msg_2', sessionID: session, type: 'step-finish', reason: 'stop' } });
} else if (kind === 'omp') {
  const session = after('--resume') ?? 'omp-session-1';
  out({ type: 'session', version: 3, id: session, timestamp: '2026-10-07T00:00:00.000Z', cwd: process.cwd() });
  out({ type: 'agent_start' });
  const user = { role: 'user', content: [{ type: 'text', text: argv.at(-1) }] };
  const assistant = mode === 'error'
    ? { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'No API key found for anthropic' }
    : { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: reply }], stopReason: 'stop', errorMessage: null };
  out({ type: 'agent_end', messages: [user, { role: 'assistant', content: [{ type: 'text', text: 'Looking at it.' }], stopReason: 'toolUse' }, assistant] });
} else if (kind === 'claude') {
  // One JSON result, as claude 2.1.292 prints it (fields the hopper does not read left out); its own error says so with is_error.
  const session = after('--resume') ?? 'claude-session-1';
  if (mode === 'error') {
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Fix external API key', session_id: session, terminal_reason: 'api_error' });
    process.exit(1);
  }
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: reply, session_id: session, permission_denials: [] });
} else {
  process.stderr.write(`fake-print-agent: FAKE_AGENT_KIND must be codex, opencode, omp or claude, not ${kind}\n`);
  process.exit(2);
}
