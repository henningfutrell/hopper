// Keyed creates (issue #1628): a call that creates something on this machine — a box through `POST /runtime`, a herdr
// tab through `POST /herdr` — names it, and that name, with a hash of the whole call, is its key: a different call under
// the same name is its own, and is checked and run as any. The hopper sends a call again, with a new nonce, when its
// answer was lost; the client answers it with the first call's answer for that key, and creates nothing again. A
// second call while the first runs waits for it. A first call that created nothing (a refusal, a failure) is not kept,
// so the call sent again runs. A key is kept CREATE_KEPT_MS: longer than any retry of the hopper's. The keys live in
// this process only: a client started again creates again, and the runtime refuses a box name in use.
// Imports nothing of hopper: it is installed on the target as plain files.
import { createHash } from 'node:crypto';

/** How long a create's answer is kept for its key. */
export const CREATE_KEPT_MS = 10 * 60_000;

/** The key of a call that creates something, or undefined: the call is no create, and runs each time. */
export function createKeyOf(path: string, body: string): string | undefined {
  let v: unknown;
  try { v = JSON.parse(body); } catch { return undefined; }
  if (typeof v !== 'object' || v === null) return undefined;
  const c = v as { args?: unknown; method?: unknown; path?: unknown; body?: unknown };
  const call = createHash('sha256').update(body).digest('hex');
  if (path === '/herdr' && Array.isArray(c.args) && c.args[0] === 'tab' && c.args[1] === 'create') {
    const args = c.args as unknown[];
    const flag = (name: string): unknown => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
    const workspace = flag('--workspace');
    const label = flag('--label');
    return typeof workspace === 'string' && typeof label === 'string' ? `herdr tab ${workspace} ${label} ${call}` : undefined;
  }
  if (path === '/runtime' && c.method === 'POST' && typeof c.path === 'string') {
    const [route = '', query = ''] = c.path.split('?');
    if (!route.endsWith('/containers/create')) return undefined;
    // Podman names the box in the body; Docker in the query.
    const named = typeof c.body === 'object' && c.body !== null ? (c.body as { name?: unknown }).name : undefined;
    const name = typeof named === 'string' ? named : new URLSearchParams(query).get('name');
    return name ? `runtime box ${name} ${call}` : undefined;
  }
  return undefined;
}

export type Creates = <T>(key: string | undefined, run: () => Promise<T>, created: (answer: T) => boolean) => Promise<T>;

/** The creates of one client: each key's first answer, kept CREATE_KEPT_MS. */
export function createOnce(now: () => number = Date.now): Creates {
  const kept = new Map<string, { at: number; answer: Promise<unknown> }>();
  return async <T>(key: string | undefined, run: () => Promise<T>, created: (answer: T) => boolean): Promise<T> => {
    if (key === undefined) return run();
    for (const [k, e] of kept) if (now() - e.at > CREATE_KEPT_MS) kept.delete(k);
    const first = kept.get(key);
    if (first) return first.answer as Promise<T>;
    const answer = run();
    const entry = { at: now(), answer };
    kept.set(key, entry);
    const forget = (): void => { if (kept.get(key) === entry) kept.delete(key); };
    answer.then((a) => { if (!created(a)) forget(); }, forget);
    return answer;
  };
}
