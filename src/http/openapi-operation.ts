// One operation of the API reference (src/http/openapi.ts), and the tags that group them: apart, so the reference's
// list of operations has room to grow.
import type { z } from 'zod';
import type { UiRole } from '../domain/types.ts';

export type Tag = 'State' | 'Jobs' | 'Questions' | 'Proposals' | 'Research' | 'Logins' | 'Failures' | 'Decider' | 'Machines and usage' | 'Plugins and routing' | 'Webhooks' | 'Vault' | 'Events' | 'Self-update' | 'Users' | 'Sign-in' | 'Access';

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
  answers?: 'html' | 'sse' | 'xml' | 'redirect';
  /** A UI mutation: the least UI role that may make it. */
  role?: UiRole;
  /** Error statuses beyond the guards'. */
  errors?: number[];
}
