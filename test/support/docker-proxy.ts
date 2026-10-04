// The docker socket the hopper uses in tests, as scripts/docker-proxy.sh sets it up on a machine: an
// allowlisting socket proxy (wollomatic/socket-proxy) that lets through inspect and exec on the named
// containers only, listening on a socket only this user can open (design.md "Target authentication").
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { proxyAllowlist, SOCKET_PROXY_IMAGE } from '../../src/executors/docker.ts';
import { waitFor } from './wait.ts';

export interface DockerProxy { host: string; stop(): void }

export async function startDockerProxy(containers: string[]): Promise<DockerProxy> {
  // Short: a unix socket path is capped at 108 bytes.
  const dir = mkdtempSync('/tmp/jh-dp-');
  chmodSync(dir, 0o700);
  const name = `jh-test-proxy-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const gid = execFileSync('stat', ['-c', '%g', '/var/run/docker.sock'], { encoding: 'utf8' }).trim();
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--user', `${process.getuid!()}:${gid}`, '-v', '/var/run/docker.sock:/var/run/docker.sock:ro', '-v', `${dir}:/run/proxy`,
    SOCKET_PROXY_IMAGE, '-proxysocketendpoint', '/run/proxy/docker.sock', ...proxyAllowlist(containers),
  ], { stdio: 'ignore' });
  const sock = join(dir, 'docker.sock');
  await waitFor(() => existsSync(sock), { timeoutMs: 30000, what: 'the docker socket proxy' });
  return {
    host: `unix://${sock}`,
    stop() {
      try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
