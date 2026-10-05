#!/usr/bin/env node
/* global process, setTimeout */
// A stand-in `herdr` binary for the CLI adapter tests. Appends {argv, env} to calls.jsonl next to
// itself and answers from a canned table. Never talks to a real herdr.
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const claudeEnv = Object.keys(process.env).filter((k) => k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_'));
appendFileSync(join(process.env.FAKE_HERDR_DIR ?? here, 'calls.jsonl'), JSON.stringify({ argv, claudeEnv }) + '\n');

const out = (o) => process.stdout.write(JSON.stringify(o));
const fail = (code, message) => {
  process.stderr.write(JSON.stringify({ error: { code, message }, id: 'cli:x' }));
  process.exit(1);
};

const cmd = argv.slice(2).join(' ');
const ws = { workspace_id: 'w7', label: 'job-hopper' };
if (cmd === 'workspace list') out({ result: { type: 'workspace_list', workspaces: process.env.FAKE_HERDR_HAS_WS ? [{ workspace_id: 'w1', label: 'other' }, ws] : [{ workspace_id: 'w1', label: 'other' }] } });
else if (cmd.startsWith('workspace create')) out({ result: { type: 'workspace_created', workspace: { workspace_id: 'w9', label: 'job-hopper' }, tab: { tab_id: 'w9:t1' }, root_pane: { pane_id: 'w9:p1' } } });
else if (cmd.startsWith('tab create')) out({ result: { type: 'tab_created', tab: { tab_id: 'w7:t3' }, root_pane: { pane_id: 'w7:p5' } } });
else if (cmd.startsWith('agent start jh-blocked')) fail('agent_not_ready', 'agent jh-blocked is blocked during startup and is not ready for prompts');
else if (cmd.startsWith('agent start jh-busy')) fail('agent_pane_busy', 'agent target pane w7:p5 is not an available shell');
else if (cmd.startsWith('agent start jh-boom')) fail('pane_not_found', 'pane w7:p404 not found');
else if (cmd.startsWith('agent start')) out({ result: { type: 'agent_started' } });
else if (cmd === 'agent get jh-gone') fail('agent_not_found', 'agent target jh-gone not found');
else if (cmd.startsWith('agent get')) out({ result: { type: 'agent_info', agent: { name: argv[4], agent_status: 'idle', state_change_seq: 4, pane_id: 'w7:p5' } } });
else if (cmd.startsWith('pane wait-output') && argv.includes('never-printed')) fail('timeout', 'timed out waiting for output match');
else if (cmd.startsWith('pane wait-output')) out({ result: { matched_line: argv[6], pane_id: argv[4] } });
else if (cmd.startsWith('pane run')) process.stdout.write(''); // herdr prints nothing
else if (cmd.startsWith('pane read')) process.stdout.write('line one\n● JOB_HOPPER_DONE\n');
else if (cmd.startsWith('agent prompt') || cmd.startsWith('pane send-keys') || cmd.startsWith('pane close w7:p5')) out({ result: { type: 'ok' } });
else if (cmd.startsWith('pane close')) fail('pane_not_found', `pane ${argv[4]} not found`);
else if (cmd === 'status server') process.stdout.write(process.env.FAKE_HERDR_RUNNING ? 'status: running\nsocket: /x/herdr.sock\n' : 'status: not running\nsocket: /x/herdr.sock\n');
else if (cmd.startsWith('slow')) setTimeout(() => out({ result: {} }), 5000);
else if (cmd.startsWith('usage')) { process.stderr.write('error: bad usage'); process.exit(2); }
else fail('unknown', `unhandled: ${cmd}`);
