// What one operator action is (issue #374, design.md "Operator actions from the CLI"): the UI call it makes, and the
// refusal a bad call is. Shared by the operator CLI and its command modules.
import type { UiRole } from './domain/types.ts';

/** A refusal: the message, exit 2. */
export class OperatorRefusal extends Error {}

/**
 * A POST of `body`, or, without one, a GET whose answer `pick` narrows; `body` may ask the daemon first (`send`). `exit`:
 * the exit code the answer gives, for a script that checks it (default 0).
 */
export interface Call { role: UiRole; path: string; body?: (get: Getter) => Promise<unknown>; pick?: (answer: unknown) => unknown; exit?: (answer: unknown) => number }
/** A GET of `path`, or with `body` a POST, on the same session. */
export type Getter = (path: string, body?: unknown) => Promise<unknown>;

export const usage = (line: string): OperatorRefusal => new OperatorRefusal(`usage: hopper ${line}`);
