// What one operator action is (issue #374, design.md "Operator actions from the CLI"): the UI call it makes, and the
// refusal a bad call is. Shared by the operator CLI and its command modules.
import type { UiRole } from './domain/types.ts';

/** A refusal: the message, exit 2. */
export class OperatorRefusal extends Error {}

/** A POST of `body`, or, without one, a GET whose answer `pick` narrows. */
export interface Call { role: UiRole; path: string; body?: (get: Getter) => Promise<unknown>; pick?: (answer: unknown) => unknown }
export type Getter = (path: string) => Promise<unknown>;

export const usage = (line: string): OperatorRefusal => new OperatorRefusal(`usage: hopper ${line}`);
