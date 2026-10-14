// claude: one job is Claude Code in print mode (`claude -p --output-format json`), on the job's machine — this one or
// an ssh target — in the job's work tree (issue #533, design.md "Print-mode agent executors"). Print mode shows no
// screen at all, so it suits a machine nobody watches: a fresh container's empty home runs it with no key press. A
// question resumes the same Claude session (`--resume`). Claude signs in on each machine it runs on (its login, or
// CLAUDE_CODE_OAUTH_TOKEN or an API key in that machine's environment).
import { printAgentPlugin } from '../print-agent.ts';

export default printAgentPlugin({
  id: 'claude',
  describe: "Claude Code on the job's machine, here or over ssh, one print-mode run per turn: no screen to answer",
  bin: 'claude', binIs: "the claude CLI on the job's machine",
  args: ['--dangerously-skip-permissions'],
  argsAre: 'its own arguments: --dangerously-skip-permissions runs its tools without asking (in print mode nobody could answer)',
});
