// Issue #59: the hopper reaches docker only through a socket that its own user alone can open — never
// the root daemon's socket, which anyone in the docker group can open and which is root on this
// machine (design.md "Target authentication"). The socket is named by HOPPER_DOCKER_HOST; in
// practice an allowlisting socket proxy (scripts/docker-proxy.sh).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { DOCKER_HOST, dockerArgv, dockerEnv, dockerHost } from '../../src/executors/docker.ts';

let dir: string;
const servers: Server[] = [];
const env = (vars: Record<string, string>) => (name: string) => vars[name];

async function socket(path: string, mode: number): Promise<string> {
  const s = createServer();
  servers.push(s);
  await new Promise<void>((r) => s.listen(path, r));
  chmodSync(path, mode);
  return path;
}

beforeEach(() => {
  // Short, like test/support/docker-proxy.ts: a unix socket path is capped at 108 bytes, and the
  // run's TMPDIR (test/support/run.ts) can be longer than that leaves room for.
  dir = mkdtempSync('/tmp/jh-dsock-');
  chmodSync(dir, 0o700);
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  rmSync(dir, { recursive: true, force: true });
});

describe('the docker socket the hopper uses', () => {
  it('a socket only the hopper\'s user can open, in a directory only it can change: used', async () => {
    const path = await socket(join(dir, 'docker.sock'), 0o600);
    expect(dockerHost(env({ [DOCKER_HOST]: `unix://${path}` }))).toBe(`unix://${path}`);
  });

  it('not set: refused, with what to set — never the default socket', () => {
    expect(() => dockerHost(env({}))).toThrow(/no docker socket for the hopper: set HOPPER_DOCKER_HOST/);
  });

  it('anything but a unix socket path: refused (a TCP daemon has no access control of its own)', () => {
    for (const bad of ['tcp://127.0.0.1:2375', 'ssh://box', 'unix://relative.sock', '/var/run/docker.sock']) {
      expect(() => dockerHost(env({ [DOCKER_HOST]: bad }))).toThrow(/must be unix:\/\/<absolute path>/);
    }
  });

  it('a socket the group or others may open: refused (the docker group is root on this machine)', async () => {
    const path = await socket(join(dir, 'docker.sock'), 0o660);
    expect(() => dockerHost(env({ [DOCKER_HOST]: `unix://${path}` }))).toThrow(/others can open it \(mode 660\)/);
  });

  it.skipIf(!existsSync('/var/run/docker.sock'))('the root daemon\'s own socket: refused', () => {
    expect(() => dockerHost(env({ [DOCKER_HOST]: 'unix:///var/run/docker.sock' }))).toThrow(/refused/);
  });

  it('a socket in a directory others may write: refused (the socket could be swapped)', async () => {
    const open = join(dir, 'open');
    mkdirSync(open, { mode: 0o777 });
    chmodSync(open, 0o777);
    const path = await socket(join(open, 'docker.sock'), 0o600);
    expect(() => dockerHost(env({ [DOCKER_HOST]: `unix://${path}` }))).toThrow(/others may write its directory/);
  });

  it('a file that is not a socket, or nothing at all: refused', () => {
    writeFileSync(join(dir, 'plain'), '', { mode: 0o600 });
    expect(() => dockerHost(env({ [DOCKER_HOST]: `unix://${join(dir, 'plain')}` }))).toThrow(/not a socket/);
    expect(() => dockerHost(env({ [DOCKER_HOST]: `unix://${join(dir, 'none')}` }))).toThrow(/cannot use .*ENOENT/);
  });

  it('every docker call names that socket, and no DOCKER_* variable of the environment reaches it', () => {
    expect(dockerArgv('unix:///run/x.sock', ['exec', '--', 'box', 'true'])).toEqual(['--host', 'unix:///run/x.sock', 'exec', '--', 'box', 'true']);
    const e = dockerEnv({ PATH: '/bin', DOCKER_HOST: 'tcp://evil', DOCKER_CONTEXT: 'other', DOCKER_TLS_VERIFY: '0', CLAUDECODE: '1' });
    expect(e).toEqual({ PATH: '/bin' });
  });
});
