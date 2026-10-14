// Payload schemas of the job's terminal (issue #1128, design.md "The job's terminal"), split from schemas.ts for its line
// budget: a terminal session opened on a job's pane, and each input to it — how much text, or which keys, never the text —,
// with their docs and examples.
import { z } from 'zod';
import { ACTION_VIAS } from '../domain/types.ts';

const strict = z.strictObject;
const who = { sessionId: z.string(), person: z.string(), via: z.enum(ACTION_VIAS) };

export const TERMINAL_EVENT_SCHEMAS = {
  'terminal.opened': strict(who),
  'terminal.typed': strict({ ...who, chars: z.number().int().positive().optional(), keys: z.array(z.string()).min(1).optional() }),
};

export const TERMINAL_EVENT_DOCS = {
  'terminal.opened': 'A person opened the job\'s terminal (issue #1128, `POST /ui/api/jobs/:id/terminal/screen`): the first read of its herdr pane by that person, or the first after two minutes with no read or input. `sessionId` names the session; `person` and `via` (`ui`, `api`, `cli`) say who and how.',
  'terminal.typed': 'A person typed into the job\'s terminal (issue #1128, `POST /ui/api/jobs/:id/terminal/input`), in the session `sessionId`: `chars`, how many characters of text were written to its pane, or `keys`, the key names pressed. The text itself is never in the event: it may hold a secret.',
};

export const TERMINAL_EVENT_EXAMPLES = {
  'terminal.opened': { sessionId: 'term-1', person: 'ada', via: 'ui' },
  'terminal.typed': { sessionId: 'term-1', person: 'ada', via: 'ui', chars: 12 },
};
