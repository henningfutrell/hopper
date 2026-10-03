import type { FastifyError, FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { EngineError } from '../engine/index.ts';

/** A refused request: `status` is sent with `{ error: message }`. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const ENGINE_STATUS = { invalid: 400, not_found: 404, conflict: 409 } as const;

/** Parse with zod; a failure is a 400 naming every problem. */
export function parseWith<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const problems = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message));
  throw new HttpError(400, problems.join('; '));
}

export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof EngineError) return reply.code(ENGINE_STATUS[err.code]).send({ error: err.message });
    const status = 'statusCode' in err && typeof err.statusCode === 'number' ? err.statusCode : 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: err.message });
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: `no route ${req.method} ${req.url}` }));
}
