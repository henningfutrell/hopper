// A routing glob (issue #18): `*` matches any run of characters (the slash too); everything else literally, any case.
// Used by the routing rules and the model rules (issue #2848). Pure.
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function glob(pattern: string, value: string): boolean {
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`, 'i').test(value);
}
