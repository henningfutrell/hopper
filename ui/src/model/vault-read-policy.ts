// The read policy on Vault (issue #716): the assets the hopper approves read on with no person, for a
// template a job asks for. The admin types the entries; the hopper checks each one when it is saved.

/** The entries typed: one per line, or comma- or space-separated, each once. None clears the policy. */
export const readPolicyEntries = (raw: string): string[] => [...new Set(raw.split(/[\s,]+/).filter(Boolean))];

/** What the policy lets the hopper do with no person. */
export const readPolicyText = (entries: readonly string[]): string => (entries.length === 0
  ? 'Empty: every template a job asks for waits for a person.'
  : `Read on ${entries.length} ${entries.length === 1 ? 'entry' : 'entries'} is approved with no person, for a template a job asks for. Write, sync and apply always wait for a person.`);
