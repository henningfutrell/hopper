// opencode: one job is the opencode CLI in print mode (`opencode run --format json`), on the job's machine
// — this one or an ssh target — in the job's work tree (issue #307, design.md "Print-mode agent
// executors"). A question resumes the same opencode session (`--session`). opencode runs its own free
// models with no sign-in; another provider signs in on each machine (`opencode auth login`).
import { printAgentPlugin } from '../print-agent.ts';

export default printAgentPlugin({
  id: 'opencode',
  describe: "The opencode CLI on the job's machine, here or over ssh, one print-mode run per turn",
  bin: 'opencode', binIs: "the opencode CLI on the job's machine",
  args: ['--auto'], argsAre: 'its own arguments: --auto approves its tools without asking',
});
