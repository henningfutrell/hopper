// codex: one job is OpenAI's Codex CLI in print mode (`codex exec --json`), on the job's machine — this
// one or an ssh target — in the job's work tree (issue #307, design.md "Print-mode agent executors"). A
// question resumes the same Codex thread (`codex exec resume`). Codex signs in on each machine it runs on
// (`codex login --device-auth`, or an API key in that machine's environment).
import { printAgentPlugin } from '../print-agent.ts';

export default printAgentPlugin({
  id: 'codex',
  describe: "OpenAI's Codex CLI on the job's machine, here or over ssh, one print-mode run per turn",
  bin: 'codex', binIs: "the Codex CLI on the job's machine",
  args: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
  argsAre: 'its own arguments: run its commands without asking or its own sandbox (the machine is the sandbox), in a work tree that need not be a git repository',
});
