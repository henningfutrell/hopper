// The places of a real container runtime the secret canary scan reads (issue #1957): what Podman keeps of the boxes, their
// homes and their images, through its own (libpod) API on its socket. For each container, its inspect output (its
// environment, labels and command), its layers as an export, and the files of its home; for each volume, its inspect
// output; for each image made since the scan's mark, its inspect output and its layers as `podman save` gives them;
// and the files of the runtime's storage this user can read (its metadata and the containers' layers). A file the
// runtime's user namespace owns (a box user's file in a volume) is not readable here: a container's home is read
// through the API instead.
import { request } from 'node:http';
import { filePlaces, type Place } from './secret-canary.ts';

const API = '/v5.0.0/libpod';
/** The most of one answer the scan reads. */
const MAX_BYTES = 256 * 1024 * 1024;

const enc = encodeURIComponent;

/** One call to the API on `socket`: its status and its body, as bytes. */
function call(socket: string, path: string): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath: socket, path: API + path, method: 'GET', timeout: 120_000 }, (res) => {
      const chunks: Buffer[] = [];
      let n = 0;
      res.on('data', (c: Buffer) => { if (n < MAX_BYTES) { chunks.push(c); n += c.length; } });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`podman did not answer GET ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

const json = async <T>(socket: string, path: string): Promise<T> => {
  const a = await call(socket, path);
  if (a.status !== 200) throw new Error(`podman answered ${a.status} to GET ${path}: ${a.body.toString('utf8')}`);
  return JSON.parse(a.body.toString('utf8')) as T;
};

/** A place of an answer: its bytes as latin1, so a tar's text is found as it is. */
const answered = async (socket: string, name: string, path: string): Promise<Place[]> => {
  const a = await call(socket, path);
  return a.status === 200 ? [{ name, text: a.body.toString('latin1') }] : [];
};

/** The ids of the images there now: the mark `runtimePlaces` reads the images made after. */
export async function imagesMark(socket: string): Promise<Set<string>> {
  return new Set((await json<{ Id: string }[]>(socket, '/images/json?all=true')).map((i) => i.Id));
}

/**
 * Every place of the runtime on `socket` (see the head of this file). `before`: the images there at the mark, whose
 * layers are not read (the runtime's base images); `home`: where a box's home is mounted.
 */
export async function runtimePlaces(socket: string, o: { before: Set<string>; home: string }): Promise<Place[]> {
  const out: Place[] = [];
  const containers = await json<{ Id: string; Names?: string[] }[]>(socket, '/containers/json?all=true');
  for (const c of containers) {
    const name = `container ${c.Names?.[0] ?? c.Id.slice(0, 12)}`;
    out.push(...await answered(socket, `${name} inspect`, `/containers/${enc(c.Id)}/json`));
    out.push(...await answered(socket, `${name} layers`, `/containers/${enc(c.Id)}/export`));
    out.push(...await answered(socket, `${name} home`, `/containers/${enc(c.Id)}/archive?path=${enc(o.home)}`));
  }
  const volumes = await json<{ Name: string }[]>(socket, '/volumes/json');
  for (const v of volumes) out.push(...await answered(socket, `volume ${v.Name} inspect`, `/volumes/${enc(v.Name)}/json`));
  const images = await json<{ Id: string; RepoTags?: string[] | null }[]>(socket, '/images/json?all=true');
  for (const i of images) {
    out.push(...await answered(socket, `image ${i.RepoTags?.[0] ?? i.Id.slice(0, 12)} inspect`, `/images/${enc(i.Id)}/json`));
    if (!o.before.has(i.Id)) out.push(...await answered(socket, `image ${i.RepoTags?.[0] ?? i.Id.slice(0, 12)} layers`, `/images/${enc(i.Id)}/get?format=docker-archive`));
  }
  const info = await json<{ store?: { graphRoot?: string } }>(socket, '/info');
  if (info.store?.graphRoot) out.push(...filePlaces('runtime storage', info.store.graphRoot));
  return out;
}

/** Whether no box or home with the label `label` is left at the runtime on `socket`. */
export async function noneLeft(socket: string, label: string): Promise<boolean> {
  const filter = enc(JSON.stringify({ label: [label] }));
  const containers = await json<unknown[]>(socket, `/containers/json?all=true&filters=${filter}`);
  const volumes = await json<unknown[]>(socket, `/volumes/json?filters=${filter}`);
  return containers.length === 0 && volumes.length === 0;
}
