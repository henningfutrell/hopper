// One read of every usage source (issue #2919): its readings, and the sources that gave none and say why (`unreadUsage`),
// so the decider, the usage report and lane tuning take usage they cannot read as unknown, never as 0%.
import { unreadUsageOf } from '../decider/usage.ts';
import type { UnreadUsage, UsageReading } from '../domain/types.ts';
import type { EngineContext } from './context.ts';

export interface UsageRead { readings: UsageReading[]; unread: UnreadUsage[] }

export async function readUsage(c: Pick<EngineContext, 'usage'>): Promise<UsageRead> {
  const sources = c.usage();
  const each = await Promise.all(sources.map((u) => u.poll()));
  return {
    readings: each.flat(),
    unread: unreadUsageOf(sources.map((u, i) => ({ name: u.name, readings: each[i]!, state: u.state?.() }))),
  };
}
