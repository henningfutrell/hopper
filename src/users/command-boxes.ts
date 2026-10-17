// One user's container-target commands (issue #865 part C, design.md "Container targets"): each in a one-shot box of the
// target's image, through the sandbox module's need box — on no network, no credential in it, burned after it and kept
// in the sandbox runs ledger, its image as the run's template.
import { randomUUID } from 'node:crypto';
import type { CommandBoxes } from '../domain/sandboxes.ts';
import { needEnv } from '../sandbox/need-box.ts';
import type { SandboxLauncher } from './sandbox-requests.ts';

export function userCommandBoxes(userId: string, launcher: Pick<SandboxLauncher, 'needStep' | 'stepProblem'>, dir: string): CommandBoxes {
  return {
    problem: () => launcher.stepProblem(userId, { offline: true }),
    run: (box, io) => {
      const id = randomUUID();
      const env = { ...box.env, ...needEnv({ command: box.script, outputs: [], credentials: [] }) };
      return launcher.needStep(userId, { name: `hopper-command-${id.slice(0, 8)}`, template: { image: box.image }, env, timeoutMs: box.timeoutMs, dir, offline: true }, io, { jobId: box.jobId, step: id, template: box.image });
    },
  };
}
