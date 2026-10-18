// The schema-drift check of a CLI's fake (issue #1958): the fields of each event a fake prints, against the fields the
// real CLI prints in events of the same kind. An event's kind is its `type`, with its `item`'s or `part`'s type when it
// has one (codex's items, opencode's parts); a field is its path, with `[]` for any element of an array.

type Json = Record<string, unknown>;

/** Each JSON object `stdout` prints: one per line, or one over all of it (a CLI that prints one result). */
function eventsOf(stdout: string): Json[] {
  const lines = stdout.split('\n').filter((l) => l.startsWith('{'));
  const parsed = lines.flatMap((l) => { try { return [JSON.parse(l) as Json]; } catch { return []; } });
  if (parsed.length) return parsed;
  try { return [JSON.parse(stdout) as Json]; } catch { return []; }
}

const typeOf = (v: unknown): string | undefined =>
  (v && typeof v === 'object' && typeof (v as Json).type === 'string' ? (v as Json).type as string : undefined);

/** An event's kind: `item.completed/agent_message`, `text/text`, `result`. */
export function kindOf(e: Json): string {
  return [typeOf(e) ?? '(no type)', typeOf(e.item), typeOf(e.part)].filter(Boolean).join('/');
}

/** Every field's path in a value: `item.text`, `messages[].content[].type`. */
export function pathsOf(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return [...new Set(v.flatMap((x) => pathsOf(x, `${at}[]`)))];
  if (!v || typeof v !== 'object') return [];
  return Object.entries(v as Json).flatMap(([k, x]) => {
    const p = at ? `${at}.${k}` : k;
    return [p, ...pathsOf(x, p)];
  });
}

/**
 * What the fake prints that the real CLI does not: an event kind it never prints, or a field none of its events of that
 * kind has. Empty: no drift.
 */
export function driftOf(fake: string, real: string): string[] {
  const realPaths = new Map<string, Set<string>>();
  for (const e of eventsOf(real)) {
    const k = kindOf(e);
    const set = realPaths.get(k) ?? new Set<string>();
    for (const p of pathsOf(e)) set.add(p);
    realPaths.set(k, set);
  }
  const drift = new Set<string>();
  for (const e of eventsOf(fake)) {
    const k = kindOf(e);
    const seen = realPaths.get(k);
    if (!seen) { drift.add(`event ${k}: the real CLI prints none`); continue; }
    for (const p of pathsOf(e)) if (!seen.has(p)) drift.add(`event ${k}: field ${p} is not in the real CLI's`);
  }
  return [...drift];
}
