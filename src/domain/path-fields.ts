// The labelled lines of a proposal's path (issue #651, issue #755): `Security: ...`, `**Effort:** ...`, and a field the
// format does not name, such as `Role:`. Agents also write several fields on one line
// (`**Security:** x. **Effort:** y.`): each is read as its own field. A bullet such as `- Hopper side: ...` is no field.
// Pure: no I/O.

/** A path's field labels, lowercased, and the field each names. */
export const PATH_LABELS: Readonly<Record<string, string>> = {
  summary: 'summary', 'tl;dr': 'summary', tldr: 'summary', security: 'security', effort: 'effort', risk: 'risk', risks: 'risk',
  friction: 'friction', 'friction for the person': 'friction', creates: 'creates', 'what it creates': 'creates',
};

/** The key of a field the format does not name: `other:` and its label as written. */
export const OTHER_FIELD = 'other:';

/** A labelled line: its label (heading, list or emphasis marks aside), lowercased, and the words after the colon. */
export function labelled(line: string): { label: string; raw: string; rest: string } | undefined {
  const m = /^[\s#>*•-]*\**_*([A-Za-z][A-Za-z ;]*?)_*\**\s*:\s*\**_*\s*(.*)$/.exec(line);
  if (m) return { label: m[1]!.trim().toLowerCase(), raw: m[1]!.trim(), rest: m[2]!.trim() };
  // A heading on its own line: `## Problem`.
  const h = /^\s{0,3}#{1,6}\s+([A-Za-z][A-Za-z ;]*?)\s*#*\s*$/.exec(line);
  return h ? { label: h[1]!.trim().toLowerCase(), raw: h[1]!.trim(), rest: '' } : undefined;
}

/** The field a label names: a known one, or, for one capitalised word, a field the format does not name. */
function fieldOf(raw: string, label: string): string | undefined {
  return PATH_LABELS[label] ?? (/^[A-Z][a-z]{1,20}$/.test(raw) ? `${OTHER_FIELD}${raw}` : undefined);
}

/** A label after the end of a sentence, or after emphasis, inside a field's words: `... day. **Role:** x`. */
const INLINE = /([.;|·]|\*\*|__)\s+(?=[*_]*([A-Za-z][A-Za-z ;]{0,30}?)[*_]*\s*:[*_]*\s)/g;

/**
 * The fields a line starts, in order, each with its words; undefined when it starts none. A field the format does not
 * name counts only on a line that is no heading and no plain bullet (`Role: x`, `- **Role:** x`), so a bullet's words
 * before a colon stay part of the field above it.
 */
export function fieldsOfLine(line: string): { field: string; rest: string }[] | undefined {
  const l = labelled(line);
  if (!l) return undefined;
  const plain = /^\s{0,3}#/.test(line) || (/^\s*[-*•+]\s/.test(line) && !/^\s*[-*•+]\s+(\*\*|__)/.test(line));
  const first = PATH_LABELS[l.label] ?? (plain ? undefined : fieldOf(l.raw, l.label));
  if (!first) return undefined;
  const fields: { field: string; rest: string }[] = [];
  let field = first;
  let from = 0;
  for (const m of l.rest.matchAll(INLINE)) {
    const next = fieldOf(m[2]!.trim(), m[2]!.trim().toLowerCase());
    if (!next) continue;
    fields.push({ field, rest: tidy(l.rest.slice(from, m.index + m[1]!.length)) });
    field = next;
    from = l.rest.length - labelled(l.rest.slice(m.index + m[0].length))!.rest.length;
  }
  fields.push({ field, rest: tidy(l.rest.slice(from)) });
  return fields;
}

/** A field's words with the emphasis marks left over from the next label taken off. */
const tidy = (s: string): string => s.replace(/\s*(\*\*|__)\s*$/, '').trim();
