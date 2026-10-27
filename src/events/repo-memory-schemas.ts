// Repository memory's events (issue #2847, design.md "Repository memory"): an entry a job learned or found wrong, a
// person's act on one, and the entries a job was offered as it started. Part of EVENT_SCHEMAS (schemas.ts), with their
// docs (docs.ts) and examples (examples.ts).
import { z } from 'zod';

const strict = z.strictObject;
const kind = z.enum(['convention', 'fix']);

export const REPO_MEMORY_EVENT_SCHEMAS = {
  'repo_memory.learned': strict({
    entry: z.string(), repo: z.string(), kind, area: z.string().optional(), text: z.string(),
    state: z.enum(['proposed', 'approved']), confidence: z.number().min(0).max(1), again: z.boolean(),
  }),
  'repo_memory.flagged': strict({ entry: z.string(), repo: z.string(), reason: z.string() }),
  'repo_memory.changed': strict({
    entry: z.string(), repo: z.string(), change: z.enum(['added', 'edited', 'approved', 'disabled', 'enabled', 'removed']), by: z.string(),
  }),
  'job.memory_offered': strict({ repo: z.string(), entries: z.array(z.string()), left: z.number().int().min(0) }),
} as const;

/** Their part of the event reference (docs.ts). */
export const REPO_MEMORY_EVENT_DOCS = {
  'repo_memory.learned': 'A finished job wrote a memory line (issue #2847): `HOPPER_MEMORY <kind>[ <area>]: <text>` in its final message. A new entry is `proposed` while the repository\'s setting asks a person to approve it, else `approved`; `again`: the repository had the same entry, and it is now more `confident` and its age renewed.',
  'repo_memory.flagged': 'A finished job wrote `HOPPER_MEMORY_WRONG <id>: <reason>` (issue #2847): the entry is `flagged`, and no job is offered it until a person approves or edits it.',
  'repo_memory.changed': 'A person added, edited, approved, disabled, enabled or removed a memory entry (issue #2847), from the UI, the API or `hopper memory`. The next job of the repository gets the change.',
  'job.memory_offered': 'The memory entries of its repository this job was told as it started (issue #2847), by id, the most confident first; `left`: the approved ones that did not fit in the settings\' `maxBytes`. Recorded again at a later start only when they changed.',
} as const;

const ENTRY = '5b0e2c7a-0000-4000-8000-000000002847';

/** Their examples (examples.ts). */
export const REPO_MEMORY_EVENT_EXAMPLES = {
  'repo_memory.learned': { entry: ENTRY, repo: 'acme/app', kind: 'convention', text: 'Run `npm run check` before a push: it runs the type check, the lint and the tests.', state: 'proposed', confidence: 0.5, again: false },
  'repo_memory.flagged': { entry: ENTRY, repo: 'acme/app', reason: 'npm run check no longer runs the tests; npm test does.' },
  'repo_memory.changed': { entry: ENTRY, repo: 'acme/app', change: 'approved', by: 'Pat' },
  'job.memory_offered': { repo: 'acme/app', entries: [ENTRY], left: 0 },
} as const;
