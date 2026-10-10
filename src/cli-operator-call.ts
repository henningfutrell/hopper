// One operator action from the command line (src/cli-operator.ts): the call it makes on the running daemon, and how
// it refuses.
import type { UiRole } from './domain/types.ts';

/** A refusal: the message, exit 2. */
export class OperatorRefusal extends Error {}

export type Getter = (path: string) => Promise<unknown>;

/** A POST of `body`, or, without one, a GET whose answer `pick` narrows. */
export interface Call { role: UiRole; path: string; body?: (get: Getter) => Promise<unknown>; pick?: (answer: unknown) => unknown }

export const usage = (line: string): OperatorRefusal => new OperatorRefusal(`usage: hopper ${line}`);
