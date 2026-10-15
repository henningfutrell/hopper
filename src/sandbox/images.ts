// The images on a machine (issue #1120, part 4): listed and removed through the runtime's own API, for the removal of the
// hopper's leftover box builds (leftover-builds.ts). Podman's libpod API and the Docker Engine API answer both calls in
// the same shape. A remove is never forced: an image a container uses, or one that is the parent of another, stays.
import type { ContainerRuntime, ListedImage, RuntimeKind } from '../domain/sandboxes.ts';
import { ok, refusal, type Answer } from './socket-http.ts';

interface Listed { Id?: string; RepoTags?: string[] | null; Created?: number; Labels?: Record<string, string> | null }

/** Docker names an untagged image `<none>:<none>`: that is no tag. */
const NO_TAG = '<none>:<none>';

export function imageCalls(kind: Exclude<RuntimeKind, 'remote'>, call: (method: string, path: string) => Promise<Answer>): Required<Pick<ContainerRuntime, 'listImages' | 'removeImage'>> {
  return {
    async listImages() {
      const a = await call('GET', `/images/json?all=${kind === 'podman' ? 'true' : '1'}`);
      if (!ok(a)) throw refusal(kind, 'list images', a);
      return (JSON.parse(a.text) as Listed[]).map((i): ListedImage => ({
        id: i.Id ?? '', tags: (i.RepoTags ?? []).filter((t) => t !== NO_TAG), createdAt: (i.Created ?? 0) * 1000, labels: i.Labels ?? {},
      }));
    },
    async removeImage(id) {
      const a = await call('DELETE', `/images/${encodeURIComponent(id)}`);
      if (ok(a)) return true;
      if (a.status === 404 || a.status === 409) return false;
      throw refusal(kind, `remove the image ${id}`, a);
    },
  };
}
