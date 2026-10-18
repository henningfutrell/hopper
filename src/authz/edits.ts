// What an edit of Access refuses, and why a request names nothing the model can hold (issue #559). Apart from
// ./service.ts for its size; it exports both.
import { profileProblem, TEMPLATE_NAME } from '../domain/types.ts';

/** What an edit refused: 400 (not valid), 404 (no such approval) or 409 (the model changed since it was read). */
export class AccessEditError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(status: 400 | 404 | 409, message: string) {
    super(message);
    this.status = status;
  }
}

/** Why a request names no template, operation or asset the model can hold, or undefined. */
export function requestProblem(r: { template: string; operation: string; asset: { kind: string; name: string } }): string | undefined {
  if (!TEMPLATE_NAME.test(r.template)) return `template ${JSON.stringify(r.template)} is not a template name (lowercase letters, digits, . _ -)`;
  return profileProblem(r);
}
