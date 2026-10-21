// The sandbox host's event (issue #2272, design.md "The sandbox host"): an admin named the machines the user's sandboxes
// start on, or cleared it. Part of EVENT_SCHEMAS (schemas.ts), with its docs (docs.ts) and example (examples.ts).
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

export const SANDBOX_HOST_EVENT_SCHEMAS = {
  'machine.sandbox_host_set': z.strictObject({ hosts: z.array(z.string()), was: z.array(z.string()), person: z.string(), via: z.enum(ACTION_VIAS) }),
} as const;

/** Its part of the event reference (docs.ts). */
export const SANDBOX_HOST_EVENT_DOCS = {
  'machine.sandbox_host_set': 'A person named the sandbox host (issue #2272): `hosts`, first first, are the machines the user\'s sandboxes start on from now on — the first one online —, never another machine; empty: cleared, and sandboxes start where they did before. `was`: the sandbox host before. A sandbox that runs already ends where it started. `person` and `via` say who and the way.',
} as const;

/** Its example (examples.ts). */
export const SANDBOX_HOST_EVENT_EXAMPLES = {
  'machine.sandbox_host_set': { hosts: ['box-vm', 'local'], was: [], person: 'Pat', via: 'ui' },
} as const;
