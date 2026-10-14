// A container target's probe (issue #58, design.md "Container targets"): whether its container runs, through the docker
// socket the hopper may open. Apart from attached.ts, which probes ssh and client targets.
import { execFile } from 'node:child_process';
import { dockerArgv, dockerEnv } from '../executors/docker.ts';

/**
 * Whether a container target runs: `docker container inspect` says it is running. A missing container
 * is not. Only through the docker socket the hopper may open (design.md "Target authentication").
 */
export function probeContainer(o: { container: string; dockerHost: () => string; dockerBin?: string; timeoutMs?: number }): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let args: string[];
    try {
      args = dockerArgv(o.dockerHost(), ['container', 'inspect', '--format', '{{.State.Running}}', '--', o.container]);
    } catch (e) {
      return reject(e instanceof Error ? e : new Error(String(e)));
    }
    execFile(o.dockerBin ?? 'docker', args, {
      env: dockerEnv(), timeout: o.timeoutMs ?? 15000, killSignal: 'SIGKILL', encoding: 'utf8',
    }, (err, stdout, stderr) => {
      const e = err as (Error & { killed?: boolean; code?: number | string }) | null;
      if (e?.killed) return reject(new Error(`docker: no answer within ${o.timeoutMs ?? 15000} ms`));
      if (e && typeof e.code !== 'number') return reject(new Error(`docker: ${e.message}`));
      if (e) return /No such container/i.test(stderr) ? resolve(false) : reject(new Error(`docker: ${stderr.trim() || e.message}`));
      resolve(stdout.trim() === 'true');
    });
  });
}
