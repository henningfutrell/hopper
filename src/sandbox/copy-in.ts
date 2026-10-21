// Files copied into a box (issue #1004): the archive call the Podman (libpod) and the Docker API share, each under its
// own prefix, over the runtime's socket beside the hopper, or a Podman host's ssh stream (issue #2272). A runtime reached
// through a machine's client has none. A copy
// is owned by the box's own user (copyUIDGID).
import type { ContainerRuntime } from '../domain/sandboxes.ts';
import { ok, refusal, socketStream, type RuntimeSocket } from './socket-http.ts';

/** How long a copy of a step's inputs may take: up to 1 GiB. */
const COPY_MS = 10 * 60_000;

const enc = encodeURIComponent;

export function copyInCall(socket: RuntimeSocket, api: string, runtime: 'podman' | 'docker'): Required<Pick<ContainerRuntime, 'copyIn'>> {
  return {
    async copyIn(id, dir, tar) {
      const a = await socketStream(socket, 'PUT', `${api}/containers/${enc(id)}/archive?path=${enc(dir)}&copyUIDGID=true`, { file: tar, timeoutMs: COPY_MS });
      if (!ok(a)) throw refusal(runtime, `copy files into the box ${id}`, a);
    },
  };
}
