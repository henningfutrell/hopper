// What a reap said, less what the job used (issue #2498 part 4): a reap of a job with a scratch dir always says the disk it
// held, so a test of what the reap kept, pushed or left compares the rest.
export function withoutUse<T extends { used?: unknown }>(said: T | undefined | void): Omit<T, 'used'> | undefined {
  if (!said) return undefined;
  const { used: _used, ...rest } = said;
  return rest;
}
