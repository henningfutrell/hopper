// The hopper's docker connection to a container target (design.md "Target authentication", issue #59).
// Docker's socket has no authentication of its own: whoever can open it is root on this machine, and
// the root daemon's socket opens to the whole docker group. So the hopper opens only a socket that its
// own user alone can open, in a directory only it can change, named by HOPPER_DOCKER_HOST — in
// practice an allowlisting socket proxy (scripts/docker-proxy.sh) that lets through inspect and exec
// on the target containers and nothing else. There is no default: never the root daemon's socket.
import { lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrubbedEnv } from './env.ts';

/** The process setting naming the docker socket the hopper uses: `unix://<absolute path>`. */
export const DOCKER_HOST = 'HOPPER_DOCKER_HOST';

/** The allowlisting socket proxy, pinned by digest (an established proxy, not one of ours). */
export const SOCKET_PROXY_IMAGE = 'wollomatic/socket-proxy:1@sha256:3935b709275e4ec35d6ed5a5c4a1f0d01ed31eec5e7234efc3357ecd47689002';

const CONTAINER = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * The proxy's allowlist for these containers: ping, inspect and exec on them (an exec started and
 * read by its id). Everything else — listing, creating, other containers, images, volumes — is
 * refused (403). The proxy anchors each pattern.
 */
export function proxyAllowlist(containers: string[]): string[] {
  for (const c of containers) if (!CONTAINER.test(c)) throw new Error(`bad container name: ${JSON.stringify(c)}`);
  const names = containers.map((c) => c.replaceAll('.', '\\.')).join('|');
  const v = 'v1\\.[0-9]+';
  return [
    '-allowHEAD', '/_ping',
    '-allowGET', `/(_ping|${v}/containers/(${names})/json|${v}/exec/[0-9a-f]{64}/json)`,
    '-allowPOST', `/${v}/(containers/(${names})/exec|exec/[0-9a-f]{64}/start)`,
  ];
}

/**
 * The docker socket the hopper may use, as a `--host` value. Throws when it is not set, is not a unix
 * socket path, or anyone but the hopper's user could open it or swap it.
 */
export function dockerHost(env: (name: string) => string | undefined): string {
  const host = env(DOCKER_HOST);
  if (!host) throw new Error(`no docker socket for the hopper: set ${DOCKER_HOST} to unix://<a socket only this user may open> (design.md "Target authentication")`);
  const path = host.startsWith('unix://') ? host.slice('unix://'.length) : '';
  if (!path.startsWith('/')) throw new Error(`${DOCKER_HOST} must be unix://<absolute path>: ${host}`);
  const refused = (why: string) => new Error(`${DOCKER_HOST} ${path} refused: ${why}`);
  const me = process.getuid!();
  let st, dir;
  try {
    st = lstatSync(path);
    dir = lstatSync(dirname(path));
  } catch (e) {
    throw refused(`cannot use it: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  if (!st.isSocket()) throw refused('not a socket');
  if (st.uid !== me) throw refused(`owned by another user (uid ${st.uid}); the hopper uses only a socket of its own`);
  if ((st.mode & 0o077) !== 0) throw refused(`others can open it (mode ${(st.mode & 0o777).toString(8)}); make it 600`);
  if (dir.uid !== me || (dir.mode & 0o022) !== 0) throw refused('others may write its directory, so the socket could be swapped');
  return host;
}

/** The docker CLI's argv against that socket. */
export const dockerArgv = (host: string, args: string[]): string[] => ['--host', host, ...args];

/** The environment of a docker call: no DOCKER_* variable may point it elsewhere. */
export function dockerEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(scrubbedEnv(env)).filter(([k]) => !k.startsWith('DOCKER_')));
}
