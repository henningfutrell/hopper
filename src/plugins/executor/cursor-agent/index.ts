// cursor-agent: one job is Cursor's CLI agent in print mode, on the job's machine — this one or an ssh
// target — in the job's work tree (issue #142, design.md "Cursor executor"). A question resumes the
// same Cursor chat. Cursor signs in on each machine it runs on (`cursor-agent login`, or CURSOR_API_KEY in
// that machine's environment).
import { printAgentPlugin } from '../print-agent.ts';

export default printAgentPlugin({
  id: 'cursor-agent',
  describe: "Cursor's agent (the Cursor CLI) on the job's machine, here or over ssh, one print-mode run per turn",
  bin: 'cursor-agent', binIs: "Cursor's CLI agent on the job's machine",
  args: ['--force', '--trust'], argsAre: 'its own arguments: --force runs its tools without asking, --trust trusts the work tree',
});
