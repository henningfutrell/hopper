// The store catalogue (design.md "Plugin store"): plugin-store.yaml at a plugin store's root,
// parsed and checked. Pure.
import { parse } from 'yaml';
import { z } from 'zod';
import { ROLES } from '../domain/types.ts';

export const CATALOGUE = 'plugin-store.yaml';

const ID = /^[a-z0-9][a-z0-9-]*$/;

/** A relative directory inside the repository: no `..`, not absolute, not the root. */
const path = z.string().refine(
  (p) => p !== '' && !p.startsWith('/') && p.split('/').every((s) => s !== '..' && s !== '.' && s !== ''),
  'path must be a relative directory inside the repository (no "..", not absolute)',
);

const schema = z.strictObject({
  version: z.literal(1),
  plugins: z.array(z.strictObject({
    id: z.string().regex(ID, `id must match ${ID}`),
    role: z.enum(ROLES),
    describe: z.string(),
    path,
  })),
}).superRefine((c, ctx) => {
  const seen = new Set<string>();
  for (const p of c.plugins) {
    if (seen.has(p.id)) ctx.addIssue({ code: 'custom', message: `id ${p.id} is listed twice`, path: ['plugins'] });
    seen.add(p.id);
  }
});

export type CatalogueEntry = z.infer<typeof schema>['plugins'][number];

export function parseCatalogue(text: string): { plugins: CatalogueEntry[] } | { error: string } {
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { error: `${CATALOGUE}: not YAML: ${e instanceof Error ? e.message : String(e)}` };
  }
  const r = schema.safeParse(doc);
  if (r.success) return { plugins: r.data.plugins };
  return { error: `${CATALOGUE}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}` };
}
