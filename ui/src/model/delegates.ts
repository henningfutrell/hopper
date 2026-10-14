// Delegate approvers on Access requests (issue #1138): which grants are delegate approvers, what each one's approver
// policy keeps the owner's, the deny entries a person types, and the command an agent runs with one. The preset's id is
// the server's (src/domain/delegates.ts), which the UI may not import at runtime.
import type { ApiGrantView } from './wire.ts';

export const DELEGATE_PRESET = 'delegate-approver';

/** The grants that are delegate approvers. */
export const delegatesOf = (grants: readonly ApiGrantView[]): ApiGrantView[] => grants.filter((g) => g.delegate !== undefined);

/** What the approver policy keeps the owner's, in words. */
export const policyText = (deny: readonly string[]): string =>
  deny.length === 0 ? 'approves anything that waits for a person' : `never approves what names ${deny.join(' or ')}: that stays yours`;

/** The deny entries in what a person typed: split on commas and spaces, each once. */
export const denyOf = (text: string): string[] => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== ''))];

/** The command an agent runs with the delegate's refresh token in a file of its own. */
export const delegateCommand = (origin: string): string =>
  `HOPPER_REFRESH_TOKEN_FILE=<file with the refresh token> HOPPER_URL=${origin} hopper grant approve <job>`;
