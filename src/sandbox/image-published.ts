// Whether an image is published (issue #1977): asked of its registry before a template request saves a template, so a
// request for an image that does not exist is refused then, with the reason, not in its read-only check later ("manifest
// unknown"). The distribution API's HEAD of the image's manifest, with the anonymous bearer token the registry asks for
// (its `WWW-Authenticate` challenge): only a 404 says the image is not published. A registry not reached, or any other
// answer, says nothing: the request goes on, and the check pulls the image as before. A local image (`localhost/…`, the
// tools images the hopper builds) is asked of no registry. Answers are kept for a while, so each request does not ask.

/** An image's reason not to be used, or undefined: published, or its registry could not say. */
export type ImageCheck = (image: string) => Promise<string | undefined>;

export interface ImageRef { registry: string; repository: string; reference: string }

/** Docker Hub's registry API host, for an image of no registry or of `docker.io`. */
const DOCKER_HUB = 'registry-1.docker.io';
const ACCEPT = [
  'application/vnd.oci.image.index.v1+json', 'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');
/** How long a published image is kept, and a missing one: one published since is seen within a minute. */
const PUBLISHED_MS = 10 * 60_000;
const MISSING_MS = 60_000;
const TIMEOUT_MS = 10_000;

/** The registry, repository and tag or digest of an image reference; undefined for a local image. */
export function imageRef(image: string): ImageRef | undefined {
  const at = image.indexOf('@');
  const name = at >= 0 ? image.slice(0, at) : image;
  const slash = name.indexOf('/');
  const first = slash >= 0 ? name.slice(0, slash) : '';
  if (first === 'localhost') return undefined;
  const hasRegistry = first.includes('.') || first.includes(':');
  let registry = hasRegistry ? first : 'docker.io';
  let path = hasRegistry ? name.slice(slash + 1) : name;
  const colon = path.lastIndexOf(':');
  const tag = colon > path.lastIndexOf('/') ? path.slice(colon + 1) : undefined;
  if (tag !== undefined) path = path.slice(0, colon);
  if (registry === 'docker.io') {
    registry = DOCKER_HUB;
    if (!path.includes('/')) path = `library/${path}`;
  }
  return { registry, repository: path, reference: at >= 0 ? image.slice(at + 1) : (tag ?? 'latest') };
}

/** The anonymous token a `Bearer` challenge names, or undefined. */
async function anonymousToken(f: typeof fetch, challenge: string | null): Promise<string | undefined> {
  if (!challenge?.toLowerCase().startsWith('bearer ')) return undefined;
  const params = Object.fromEntries([...challenge.slice(7).matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1]!, m[2]!]));
  if (!params.realm) return undefined;
  const query = new URLSearchParams({ ...(params.service ? { service: params.service } : {}), ...(params.scope ? { scope: params.scope } : {}) });
  const r = await f(`${params.realm}?${query.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) return undefined;
  const body = await r.json() as { token?: unknown; access_token?: unknown };
  const token = body.token ?? body.access_token;
  return typeof token === 'string' ? token : undefined;
}

/** The status of the image's manifest at its registry, or undefined when it could not be read. */
async function manifestStatus(f: typeof fetch, ref: ImageRef): Promise<number | undefined> {
  const url = `https://${ref.registry}/v2/${ref.repository}/manifests/${ref.reference}`;
  const head = (token?: string) => f(url, { method: 'HEAD', headers: { accept: ACCEPT, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  let r = await head();
  if (r.status === 401) {
    const token = await anonymousToken(f, r.headers.get('www-authenticate'));
    if (!token) return undefined;
    r = await head(token);
  }
  return r.status;
}

export function createImageCheck(o: { fetch?: typeof fetch; now?: () => number } = {}): ImageCheck {
  const f = o.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const now = o.now ?? Date.now;
  const kept = new Map<string, { problem: string | undefined; until: number }>();
  return async (image) => {
    const ref = imageRef(image);
    if (!ref) return undefined;
    const was = kept.get(image);
    if (was && was.until > now()) return was.problem;
    const status = await manifestStatus(f, ref).catch(() => undefined);
    if (status === 404) {
      const problem = `the image ${image} is not published: its registry answers manifest unknown`;
      kept.set(image, { problem, until: now() + MISSING_MS });
      return problem;
    }
    if (status !== undefined && status >= 200 && status < 300) kept.set(image, { problem: undefined, until: now() + PUBLISHED_MS });
    return undefined;
  };
}
