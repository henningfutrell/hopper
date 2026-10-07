// omp: one job is the oh-my-pi coding agent's CLI in print mode (`omp -p --mode json`), on the job's
// machine — this one or an ssh target — in the job's work tree (issue #307, design.md "Print-mode agent
// executors"). A question resumes the same omp session (`--resume`). omp signs in to a model provider on
// each machine it runs on (`omp login`, or a provider's API key in that machine's environment).
import { printAgentPlugin } from '../print-agent.ts';

export default printAgentPlugin({
  id: 'omp',
  describe: "The omp (oh-my-pi) coding agent on the job's machine, here or over ssh, one print-mode run per turn",
  bin: 'omp', binIs: "the omp CLI on the job's machine",
  args: ['--auto-approve'], argsAre: 'its own arguments: --auto-approve runs its tools without asking',
});
