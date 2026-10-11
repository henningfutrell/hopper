// Settings → Intake (issue #652), pure: the logins a person typed, one per line or split by commas or spaces —
// lowercased, sorted, once each, as the daemon keeps them.
export function actorsOf(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((l) => l.trim().replace(/^@/, '').toLowerCase()).filter((l) => l !== ''))].sort();
}
