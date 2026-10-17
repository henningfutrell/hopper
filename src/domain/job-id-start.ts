// A job by the start of its id (issue #1780): the views show a job by its **short id**, the first 8 characters of its
// id, so the operator CLI's `job show` takes one. Pure.

/** The fewest characters of an id that name a job: a short id. */
export const SHORT_ID_LENGTH = 8;

/** The one id of `ids` that starts with `start`; `ambiguous`: how many do, when more than one does. A start shorter than a short id, or with a character no id has, names none. */
export function jobIdStarting(ids: Iterable<string>, start: string): { id?: string; ambiguous?: number } {
  if (start.length < SHORT_ID_LENGTH || !/^[0-9a-f-]+$/i.test(start)) return {};
  const found = [...ids].filter((id) => id.startsWith(start.toLowerCase()));
  if (found.length > 1) return { ambiguous: found.length };
  return found.length === 1 ? { id: found[0]! } : {};
}
