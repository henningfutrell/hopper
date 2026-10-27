#!/usr/bin/env node
/* global Buffer, process, setInterval */
// A stand-in for the agent CLIs the print-mode executors run (issue #307): `codex exec --json`,
// `opencode run --format json`, `omp -p --mode json` and `claude -p --output-format json` (issue #533), chosen by $FAKE_AGENT_KIND. Appends its argv,
// cwd and the environment the hopper sets to agent-calls.jsonl in $FAKE_AGENT_DIR, then answers as that
// CLI does — JSON events, one per line, in the shapes each prints (taken from the real CLIs, 2026-10-07).
// The reply is $FAKE_AGENT_REPLY; $FAKE_AGENT_REPLIES (a JSON array) gives the reply of each call in
// turn. $FAKE_AGENT_MODE `error` answers the CLI's own error, `hang` never answers. Faults (issue #1958), each in
// the CLI's own shape: `partial-hang` prints the events before the answer and half a line, then hangs; `malformed`
// prints a cut line before the answer (claude: its one result cut); `permission-prompt` asks on a terminal it does not
// have and exits 1; `huge` puts $FAKE_AGENT_HUGE_MB of tool output before the answer; `non-utf8` puts a byte that is not
// UTF-8 in the answer's word "greeting"; `no-final` prints the events before the answer only, and exits 0. Like the real
// CLIs, it reads stdin to its end first, and logs it. `opencode session delete <id>` (a draft's cleanup, issue #474) only
// appends the id, its argv and the opencode variables it ran with to opencode-deleted.jsonl. As opencode 2 does
// (issue #2862), opencode refuses `--pure` and `--variant`: it prints its help and exits 1.
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// As the real codex and opencode do when stdin is not a terminal: read it to its end before the turn.
// A turn that hands the CLI an open stdin never starts (found on the agent boxes, issue #307).
const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');

const argv = process.argv.slice(2);
if (process.env.FAKE_AGENT_KIND === 'opencode' && argv.some((a) => a === '--pure' || a === '--variant')) {
  process.stdout.write('DESCRIPTION\n  Run OpenCode with a message\n');
  process.exit(1);
}
if (process.env.FAKE_AGENT_KIND === 'opencode' && argv[0] === 'session' && argv[1] === 'delete') {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OPENCODE_')));
  appendFileSync(join(process.env.FAKE_AGENT_DIR, 'opencode-deleted.jsonl'), `${JSON.stringify({ id: argv[2], argv, env })}\n`);
  process.exit(0);
}
const log = join(process.env.FAKE_AGENT_DIR, 'agent-calls.jsonl');
appendFileSync(log, JSON.stringify({
  argv, cwd: process.cwd(), stdin,
  env: { TMPDIR: process.env.TMPDIR, HOPPER_JOB_ID: process.env.HOPPER_JOB_ID, CHECKPOINT_DISABLE: process.env.CHECKPOINT_DISABLE, GRADLE_OPTS: process.env.GRADLE_OPTS, MAVEN_OPTS: process.env.MAVEN_OPTS, NODE_OPTIONS: process.env.NODE_OPTIONS, HOPPER_REPO: process.env.HOPPER_REPO, HOPPER_URL: process.env.HOPPER_URL },
  // Where it runs (issue #1295): in the job's sandbox, with podman a client of the job's socket.
  sandbox: { sandboxed: process.env.HOPPER_SANDBOXED, containerHost: process.env.CONTAINER_HOST, pid: process.pid },
}) + '\n');
const kind = process.env.FAKE_AGENT_KIND;
const mode = process.env.FAKE_AGENT_MODE ?? 'ok';
const calls = readFileSync(log, 'utf8').trim().split('\n').length;
const replies = process.env.FAKE_AGENT_REPLIES ? JSON.parse(process.env.FAKE_AGENT_REPLIES) : undefined;
const reply = replies ? replies[Math.min(calls, replies.length) - 1] : (process.env.FAKE_AGENT_REPLY ?? '');
const after = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
/** The events the turn prints, in order; `starts`, how many of them come before the answer. */
const lines = [];
let starts = 0;
const out = (o) => { lines.push(JSON.stringify(o)); };
const begun = () => { starts = lines.length; };
/** The CLI's own error: what it printed so far, then its exit code. */
const printed = (code) => { process.stdout.write(lines.map((l) => `${l}\n`).join('')); process.exit(code); };
/** The tool output before the answer: $FAKE_AGENT_HUGE_MB of it with `huge`. */
const toolOutput = mode === 'huge' ? 'x'.repeat(Number(process.env.FAKE_AGENT_HUGE_MB) * 1024 * 1024) : '';
/** With `non-utf8`, a mark in the answer that becomes a byte that is not UTF-8 when it is printed. */
const MARK = '\u00a7';
const answer = mode === 'non-utf8' ? reply.replace('greeting', `gr${MARK}(eeting`) : reply;
const PROMPT = 'Allow the command `rm -rf build`? [y/N]';

// `leave`, `escape`: what a careless turn leaves (issue #410): a temp file, and a process that left its session,
// named $FAKE_AGENT_LEFTOVER — with `escape`, one that cleared its environment too. bash, for `exec -a`: dash, a
// distribution's sh, has none (issue #672).
if (mode === 'leave' || mode === 'escape') {
  writeFileSync(join(process.env.TMPDIR, 'left.txt'), 'x');
  spawn('setsid', ['bash', '-c', `exec -a ${process.env.FAKE_AGENT_LEFTOVER} sleep 300`], { detached: true, stdio: 'ignore', env: mode === 'escape' ? {} : process.env }).unref();
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
  begun();
  if (mode === 'error') {
    out({ type: 'error', message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' });
    out({ type: 'turn.failed', error: { message: 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header' } });
    printed(1);
  }
  out({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: 'Looking at it.' } });
  out({ type: 'item.completed', item: { id: 'item_1', type: 'command_execution', command: 'ls', aggregated_output: toolOutput, exit_code: 0, status: 'completed' } });
  out({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: answer } });
  out({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } });
} else if (kind === 'opencode') {
  const session = after('--session') ?? 'ses_1';
  if (mode === 'error') {
    out({ type: 'error', timestamp: 1, sessionID: session, error: { name: 'APIError', data: { message: 'Not Found', statusCode: 404 } } });
    printed(1);
  }
  // Two steps: the agent's earlier text, a tool, then its last message — the answer.
  out({ type: 'step_start', timestamp: 1, sessionID: session, part: { id: 'p1', messageID: 'msg_1', sessionID: session, type: 'step-start' } });
  begun();
  out({ type: 'text', timestamp: 2, sessionID: session, part: { id: 'p2', messageID: 'msg_1', sessionID: session, type: 'text', text: `Looking at it.${toolOutput}` } });
  out({ type: 'step_finish', timestamp: 3, sessionID: session, part: { id: 'p3', messageID: 'msg_1', sessionID: session, type: 'step-finish', reason: 'tool-calls' } });
  out({ type: 'step_start', timestamp: 4, sessionID: session, part: { id: 'p4', messageID: 'msg_2', sessionID: session, type: 'step-start' } });
  const [head, ...rest] = answer.split('\n');
  out({ type: 'text', timestamp: 5, sessionID: session, part: { id: 'p5', messageID: 'msg_2', sessionID: session, type: 'text', text: head } });
  if (rest.length) out({ type: 'text', timestamp: 6, sessionID: session, part: { id: 'p6', messageID: 'msg_2', sessionID: session, type: 'text', text: `\n${rest.join('\n')}` } });
  out({ type: 'step_finish', timestamp: 7, sessionID: session, part: { id: 'p7', messageID: 'msg_2', sessionID: session, type: 'step-finish', reason: 'stop' } });
} else if (kind === 'omp') {
  const session = after('--resume') ?? 'omp-session-1';
  out({ type: 'session', version: 3, id: session, timestamp: '2026-10-07T00:00:00.000Z', cwd: process.cwd() });
  out({ type: 'agent_start' });
  begun();
  const user = { role: 'user', content: [{ type: 'text', text: argv.at(-1) }] };
  const assistant = mode === 'error'
    ? { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'No API key found for anthropic' }
    : { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: answer }], stopReason: 'stop' };
  out({ type: 'agent_end', messages: [user, { role: 'assistant', content: [{ type: 'text', text: `Looking at it.${toolOutput}` }], stopReason: 'toolUse' }, assistant] });
} else if (kind === 'claude') {
  // One JSON result, as claude 2.1.292 prints it (fields the hopper does not read left out); its own error says so with is_error.
  const session = after('--resume') ?? 'claude-session-1';
  if (mode === 'error') {
    out({ type: 'result', subtype: 'success', is_error: true, api_error_status: 401, result: 'Invalid API key · Fix external API key', session_id: session, terminal_reason: 'api_error' });
    printed(1);
  }
  // Its token use, per model (issue #2302): what the hopper keeps in the token ledger. The real CLI names the model
  // it was given.
  const modelUsage = { [after('--model') ?? 'claude-opus-5-5']: { inputTokens: 3, outputTokens: 30, cacheReadInputTokens: 300, cacheCreationInputTokens: 20, costUSD: 0.01 } };
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: toolOutput ? `${toolOutput}\n${answer}` : answer, session_id: session, permission_denials: [], modelUsage });
} else {
  process.stderr.write(`fake-print-agent: FAKE_AGENT_KIND must be codex, opencode, omp or claude, not ${kind}\n`);
  process.exit(2);
}

if (mode === 'permission-prompt') {
  // The prompt waits on a terminal; stdin is no terminal and is already at its end, so the CLI gives up.
  process.stdout.write(`${PROMPT} `);
  process.stderr.write(`Error: the permission prompt needs a terminal: ${PROMPT}\n`);
  process.exit(1);
}
if (mode === 'partial-hang') {
  const next = lines[starts] ?? '';
  process.stdout.write(`${lines.slice(0, starts).map((l) => `${l}\n`).join('')}${next.slice(0, Math.ceil(next.length / 2))}`);
  setInterval(() => {}, 1000);
} else if (mode !== 'hang') {
  let shown = lines;
  if (mode === 'no-final') shown = lines.slice(0, starts);
  // Claude Code prints one result: cut, it is not JSON. A stream gets a cut line before its answer.
  if (mode === 'malformed') shown = kind === 'claude' ? [lines[0].slice(0, 60)] : [...lines.slice(0, starts), lines[starts].slice(0, 40), ...lines.slice(starts)];
  const text = Buffer.from(shown.map((l) => `${l}\n`).join(''));
  if (mode !== 'non-utf8') process.stdout.write(text);
  else {
    const mark = Buffer.from(MARK);
    const at = text.indexOf(mark);
    process.stdout.write(Buffer.concat([text.subarray(0, at), Buffer.from([0xc3]), text.subarray(at + mark.length)]));
  }
}
