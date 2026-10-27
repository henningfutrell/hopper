// What one operator action is (issue #374, design.md "Operator actions from the CLI"): the UI call it makes, and the
// refusal a bad call is, and how a call is sent to the daemon (with a session's headers, or a grant's API token, issue
// #1138) and its answer printed. Shared by the operator CLI and its command modules.
import type { UiRole } from './domain/types.ts';

/** A refusal: the message, exit 2. */
export class OperatorRefusal extends Error {}

/**
 * A POST of `body`, or, without one, a GET whose answer `pick` narrows; `body` may ask the daemon first (`send`). `post`: a
 * POST whose path is found first too (`path` is then the route's pattern). `exit`: the exit code the answer gives, for a
 * script that checks it (default 0). `as`: who the CLI's own session names as the person who acts (issue #2220); it gives
 * no role or permission of theirs. `raw`: a text answer (a CSV) is printed as it is, not as JSON (issue #2861).
 */
export interface Call {
  role: UiRole; path: string; body?: (get: Getter) => Promise<unknown>; post?: (get: Getter) => Promise<{ path: string; body: unknown }>;
  pick?: (answer: unknown) => unknown; exit?: (answer: unknown) => number; as?: string; raw?: boolean;
}
/** A GET of `path`, or with `body` a POST, on the same session. */
export type Getter = (path: string, body?: unknown) => Promise<unknown>;

export const usage = (line: string): OperatorRefusal => new OperatorRefusal(`usage: hopper ${line}`);

/** The call on the daemon, its answer printed; the exit code the call gives it. */
export async function perform(call: Call, send: Getter, io: { out(text: string): void }): Promise<number> {
  const post = call.post ? await call.post(send) : undefined;
  const answer = post ? await send(post.path, post.body) : call.body ? await send(call.path, await call.body(send)) : await send(call.path);
  const shown = call.pick ? call.pick(answer) : answer;
  io.out(call.raw && typeof shown === 'string' ? shown : `${JSON.stringify(shown, null, 2)}\n`);
  return call.exit ? call.exit(answer) : 0;
}

/** A GET of `path`, or with `body` a JSON POST, to the daemon with these headers; a refusal is an OperatorRefusal. */
export function sender(url: URL, headers: Record<string, string>): Getter {
  return async (path, body) => {
    let res: Response;
    try {
      res = await fetch(new URL(path, url), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      throw new Error(`no hopper answers at ${url.origin} (${(e as Error).message}): is the daemon running? --url names it`, { cause: e });
    }
    const text = await res.text();
    let parsed: unknown;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    if (res.ok) return parsed;
    const why = (parsed as { error?: string } | undefined)?.error ?? text;
    if (res.status >= 400 && res.status < 500) throw new OperatorRefusal(`refused (${res.status}): ${why}`);
    throw new Error(`the hopper failed (${res.status}): ${why}`);
  };
}
