// Writes docs/schemas/*.json and docs/events.md from src/events. Run: npm run schemas
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEventsMarkdown } from '../src/events/docs.ts';
import { exportJsonSchemas } from '../src/events/export.ts';

const docs = join(import.meta.dirname, '..', 'docs');
mkdirSync(join(docs, 'schemas'), { recursive: true });
const files = exportJsonSchemas();
for (const [name, schema] of Object.entries(files)) {
  writeFileSync(join(docs, 'schemas', name), `${JSON.stringify(schema, null, 2)}\n`);
}
writeFileSync(join(docs, 'events.md'), renderEventsMarkdown());
console.log(`wrote ${Object.keys(files).length} schemas and docs/events.md`);
