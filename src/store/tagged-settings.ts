// What a job source keeps of its tagged items (issue #1141), apart from settings.ts for its size: a user's key-value
// setting per source instance, absent until its first read.
import type { TaggedRecord } from '../domain/tagged.ts';

export function taggedSettings(read: (key: string) => string | undefined, write: (key: string, value: string) => void): {
  getTaggedRecord(source: string): TaggedRecord | undefined;
  setTaggedRecord(source: string, record: TaggedRecord): void;
} {
  return {
    getTaggedRecord(source) {
      const text = read(`tagged:${source}`);
      return text === undefined ? undefined : JSON.parse(text) as TaggedRecord;
    },
    setTaggedRecord(source, record) {
      write(`tagged:${source}`, JSON.stringify({ reviewRequested: record.reviewRequested, dismissed: record.dismissed.map((d) => ({ key: d.key, why: d.why })) }));
    },
  };
}
