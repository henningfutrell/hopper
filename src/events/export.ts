// JSON Schema documents for docs/schemas/. `$schema` is kept: these are docs for consumers.
import { z } from 'zod';
import { EVENT_SCHEMA_VERSIONS, EVENT_TYPES } from '../domain/types.ts';
import { ENVELOPE_SCHEMA, EVENT_SCHEMAS } from './schemas.ts';

const toJson = (s: z.ZodType): object => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

/** filename → JSON Schema: `envelope.v1.json` and `<type>.v<N>.json` (the `data` payload). */
export function exportJsonSchemas(): Record<string, object> {
  const out: Record<string, object> = { 'envelope.v1.json': toJson(ENVELOPE_SCHEMA) };
  for (const t of EVENT_TYPES) out[`${t}.v${EVENT_SCHEMA_VERSIONS[t]}.json`] = toJson(EVENT_SCHEMAS[t]);
  return out;
}
