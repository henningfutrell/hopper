// The new repositories' events (issue #2795, design.md "New repositories"): what one read of what a connected account
// reaches asked about for the first time, and what the new-repository policy added to the job repositories. `key`: a further
// connected account's (issue #1448); absent: the first's. Part of EVENT_SCHEMAS (schemas.ts), with their docs (docs.ts) and
// examples (examples.ts).
import { z } from 'zod';
import { CONNECTED_ACCOUNT_PROVIDERS } from '../domain/types.ts';

const found = z.strictObject({ provider: z.enum(CONNECTED_ACCOUNT_PROVIDERS), key: z.string().optional(), account: z.string(), repositories: z.array(z.string()).min(1) });

export const NEW_REPOSITORY_EVENT_SCHEMAS = {
  'connected_account.new_repositories_asked': found,
  'connected_account.new_repositories_accepted': found,
} as const;

/** Their part of the event reference (docs.ts). */
export const NEW_REPOSITORY_EVENT_DOCS = {
  'connected_account.new_repositories_asked': 'A read of what the user\'s connected account reaches found repositories that no read before saw, and the new-repository policy is `ask` for their owner (issue #2795): each is a new-repository ask in Sources, for a person to add to the job repositories or dismiss. Only the repositories asked about for the first time; the first read of an account asks about none. The notifiers send it.',
  'connected_account.new_repositories_accepted': 'The new-repository policy added repositories to the job repositories of the user\'s connected account (issue #2795): new ones a read found, or asks that waited when a person set their owner\'s mode to `accept`. The source syncs at once.',
} as const;

/** Their examples (examples.ts). */
export const NEW_REPOSITORY_EVENT_EXAMPLES = {
  'connected_account.new_repositories_asked': { provider: 'github', account: 'octocat', repositories: ['octocat/web'] },
  'connected_account.new_repositories_accepted': { provider: 'github', account: 'octocat', repositories: ['octocat/api'] },
} as const;
