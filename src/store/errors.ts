/** A job with this source key already exists (dedupe is by key). */
export class DuplicateSourceKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`a job for source key already exists: ${key}`);
    this.name = 'DuplicateSourceKeyError';
    this.key = key;
  }
}
