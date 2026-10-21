// An event type's family (issue #2375), pure: the part before its first dot (job.started → job). The Events view's filter
// chips are the families of the events it holds, each with its count, by name.
import type { DomainEvent } from '@/model/wire';

export const eventFamily = (type: string): string => type.split('.')[0]!;

export function eventFamilies(events: readonly Pick<DomainEvent, 'type'>[]): { family: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(eventFamily(e.type), (counts.get(eventFamily(e.type)) ?? 0) + 1);
  return [...counts].map(([family, count]) => ({ family, count })).sort((a, b) => a.family.localeCompare(b.family));
}
