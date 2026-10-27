#!/usr/bin/env node
/* global process, setInterval */
// A stand-in for the calls a draft probe makes (issue #474): each draft provider's sign-in status and its model list,
// chosen by $FAKE_PROBE_KIND (claude, codex, cursor-agent, opencode, omp), in the shapes the real CLIs print (taken
// from claude 2.1, codex-cli 0.160, cursor-agent 2026.10, omp 18.7 on 2026-10-17, opencode 2.1 on 2026-10-26). Appends its argv and
// stdin to probe-calls.jsonl in $FAKE_PROBE_DIR. $FAKE_PROBE_MODE `signed-out` answers as a CLI with no login does,
// `hang` never answers, `no-models` lists none. As opencode 2 does, opencode refuses `--pure`: it prints its help and exits 1.
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
const argv = process.argv.slice(2);
appendFileSync(join(process.env.FAKE_PROBE_DIR, 'probe-calls.jsonl'), `${JSON.stringify({ argv, stdin, cwd: process.cwd() })}\n`);
const kind = process.env.FAKE_PROBE_KIND;
const mode = process.env.FAKE_PROBE_MODE ?? 'ok';
const out = (s) => process.stdout.write(s);
const call = argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ');
const signedOut = mode === 'signed-out';
const none = mode === 'no-models';

if (mode === 'hang') setInterval(() => {}, 1000);
else if (kind === 'claude' && call === 'auth status') {
  // The real one also names the account's email: the probe must read only `loggedIn`.
  out(`${JSON.stringify({ loggedIn: !signedOut, authMethod: 'claude.ai', email: 'someone@example.com', orgName: 'Example' }, null, 2)}\n`);
  process.exit(signedOut ? 1 : 0);
} else if (kind === 'claude' && argv.includes('--input-format')) {
  const { request_id } = JSON.parse(stdin.split('\n')[0]);
  const models = none ? [] : [{ value: 'opus', displayName: 'Opus X', description: 'complex work' }, { value: 'haiku', displayName: 'Haiku X' }];
  out(`${JSON.stringify({ type: 'system', subtype: 'init' })}\n${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id, response: { models } } })}\n`);
} else if (kind === 'codex' && call === 'login status') {
  if (signedOut) { process.stderr.write('Not logged in\n'); process.exit(1); }
  process.stderr.write('Logged in using ChatGPT\n');
} else if (kind === 'codex' && call === 'debug models') {
  const level = (effort) => ({ effort, description: effort });
  out(`${JSON.stringify({ models: none ? [] : [
    { slug: 'gpt-x', display_name: 'GPT-X', description: 'Frontier work.', visibility: 'list', supported_reasoning_levels: [level('low'), level('high')] },
    { slug: 'gpt-x-review', display_name: 'GPT-X review', description: 'Hidden.', visibility: 'hide' },
    { slug: 'gpt-y', display_name: 'GPT-Y', visibility: 'list' },
  ] })}\n`);
} else if (kind === 'cursor-agent' && call === 'status') {
  out(signedOut ? '\nNot logged in\n' : '\n ✓ Logged in as someone@example.com\n');
} else if (kind === 'cursor-agent' && call === 'models') {
  if (signedOut) { process.stderr.write('Error: Authentication required. Please run \'agent login\' first.\n'); process.exit(1); }
  out(none ? 'Available models\n\n' : 'Loading models…\nAvailable models\n\nauto - Auto\ngpt-x - GPT-X  (current, default)\nsonnet-x-thinking - Sonnet X Thinking\n\nTip: use --model <id> to switch.\n');
} else if (kind === 'opencode' && argv.includes('--pure')) {
  out('DESCRIPTION\n  List all available models\n');
  process.exit(1);
} else if (kind === 'opencode' && call === 'models') {
  out(none ? '' : 'opencode/big-pickle\nopencode/glm-flash-free\nanthropic/claude-x\n');
} else if (kind === 'omp' && call === 'models') {
  out(`${JSON.stringify({ models: none ? [] : [
    { provider: 'anthropic', id: 'claude-x', selector: 'anthropic/claude-x', name: 'Claude X' },
    { provider: 'openai', id: 'gpt-x', selector: 'openai/gpt-x', name: 'GPT-X' },
  ] })}\n`);
} else {
  process.stderr.write(`fake-probe-cli: no ${kind} call ${argv.join(' ')}\n`);
  process.exit(2);
}
