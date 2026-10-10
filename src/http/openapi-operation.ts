// One operation of the API reference (src/http/openapi.ts), and the tags that group them with what each is: apart, so
// the reference's list of operations has room to grow.
import type { z } from 'zod';
import type { UiRole } from '../domain/types.ts';

export type Tag = 'State' | 'Jobs' | 'Questions' | 'Proposals' | 'Research' | 'Logins' | 'Failures' | 'Decider' | 'Machines and usage' | 'Plugins and routing' | 'Webhooks' | 'Vault' | 'Events' | 'Self-update' | 'Users' | 'Sign-in' | 'Access' | 'Bug reports';

export interface Operation {
  method: 'get' | 'post';
  /** Fastify's form: `/api/jobs/:id`. */
  path: string;
  tag: Tag;
  summary: string;
  description?: string;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Body media type; default JSON. */
  form?: boolean;
  /** What a 200 carries. */
  returns: string;
  /** Answer media type; default JSON. */
  answers?: 'html' | 'sse' | 'xml' | 'markdown' | 'redirect';
  /** A UI mutation: the least UI role that may make it. */
  role?: UiRole;
  /** Error statuses beyond the guards'. */
  errors?: number[];
}

/** What each tag groups, as the reference shows it. */
export const TAGS: Record<Tag, string> = {
  State: 'What the hopper is doing: health, the queue, decisions, the router.',
  Jobs: 'Jobs and the job sources they are pulled from.',
  Questions: 'Questions a running job asks, and the gates they pass.',
  Proposals: 'Proposals a job wrote instead of doing the work: reviewed by the reviewer levels, signed off by a person. A review section, as Research is. Never a question.',
  Research: 'Research reports a job wrote instead of doing the work: accepted, dug deeper on or steered by a person, each round kept. A review section, as Proposals is. Never a question.',
  Logins: 'Logins a job or run waits on (a CLI showing a device code): never a question.',
  Failures: 'What the failure assessor made of the failed jobs: problems grouped from shared causes, assessed failures, the failure profile, and its settings.',
  'Decider': 'Bounded choices Jev makes first, before a model or a person: each decision point\'s mode, threshold and agreement rate, and every pick.',
  'Machines and usage': 'Where jobs run, and the usage that throttles lanes.',
  'Plugins and routing': 'Which plugin instance fills which role, and the routing rules.',
  Webhooks: 'Subscribers to the event log, kept in the database.',
  Vault: 'Write-only secrets for jobs: set once, never read back. The master key every kept secret is sealed under: given at launch, never from a file or a volume.',
  Events: 'The event log, read back or streamed.',
  'Self-update': 'The install and the update repository.',
  Users: 'The people one hopper works for, each with their own work, kept apart.',
  'Sign-in': 'UI sessions: sign-in, the session, logout.',
  Access: 'OpenFGA decides each credential a job is given: the approvals, the access model, and every decision.',
  'Bug reports': 'Report a bug: a report on the hopper, with its redacted context, filed on the hopper\'s own repository as the person who sends it.',
};
